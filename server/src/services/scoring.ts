/**
 * 추천종목 스코어링 엔진
 *
 * 가중치 기반 점수 누적:
 *   - 연속 BUY 신호: 매 연속 +10 (최대 50)
 *   - 높은 신뢰도: confidence 기반 가중치
 *   - 거래량 급증: 평균 대비 1.5배 이상 +15
 *   - 기술적 반등 신호: RSI 과매도 탈출, 볼린저 하단 반등 등
 *   - 뉴스 호재: 뉴스 존재 시 +5
 *   - MACD 골든크로스: +20
 *   - 시간 감쇠: 오래된 점수는 자연 감소
 *
 * 임계값:
 *   - 80점 이상: 관심종목으로 자동 승격 + 알림
 *   - 100점 이상 + 자동매매 활성: 매수 실행
 */

import { queryAll, queryOne, execute } from '../db';
import { TechnicalIndicators } from './technicalAnalysis';
import { TradeDecision } from './llm';
import { createNotification } from './notification';
import { getSettings } from './settings';
import { loadWeights } from './weightOptimizer';
import { checkPromotionEligibility } from './portfolioManager';
import type { QuoteBook } from './quoteBook';
import { normalizeMarket } from './marketNormalizer';
import logger from '../logger';

// ─── 스코어 타입 ──────────────────────────────────────────

export type ScoreType =
  | 'CONSECUTIVE_BUY'   // 연속 BUY 신호
  | 'HIGH_CONFIDENCE'   // 높은 신뢰도
  | 'VOLUME_SURGE'      // 거래량 급증
  | 'RSI_OVERSOLD_BOUNCE' // RSI 과매도 반등
  | 'BOLLINGER_BOUNCE'  // 볼린저 하단 반등
  | 'MACD_GOLDEN_CROSS' // MACD 골든크로스
  | 'PRICE_MOMENTUM'    // 가격 모멘텀 (연속 상승)
  | 'NEWS_POSITIVE'     // 뉴스 호재
  | 'NEWS_SENTIMENT'    // 뉴스 감성 점수
  | 'TIME_DECAY'        // 시간 감쇠
  | 'SPREAD_TIGHT'      // 타이트 호가 스프레드 (+10)
  | 'BOOK_DEPTH_STRONG' // 충분한 호가 깊이 (+5)
  | 'SPREAD_WIDE';      // 넓은 스프레드 감점 (-15)

const WATCHLIST_THRESHOLD = 80;
const AUTO_TRADE_THRESHOLD = 100;

// ─── 스코어 계산 ──────────────────────────────────────────

export interface ScoreResult {
  totalScore: number;
  details: { type: ScoreType; value: number; reason: string }[];
  promoted: boolean;
  promotedTo?: 'watchlist' | 'auto_trade';
}

/** 추천 종목의 점수를 계산하고 업데이트 */
export async function evaluateAndScore(
  ticker: string,
  market: string,
  decision: TradeDecision,
  indicators?: TechnicalIndicators,
  volumeAnalysis?: { avgVolume20d: number; todayVsAvg: number; volumeTrend: string },
  sentimentScore?: number,
  quoteBook?: QuoteBook,
): Promise<ScoreResult> {
  const details: { type: ScoreType; value: number; reason: string }[] = [];
  const weights = loadWeights();

  // 기존 누적 점수 가져오기 (최근 7일)
  const existingScores = queryAll(
    `SELECT SUM(score_value) as total FROM recommendation_scores
     WHERE ticker = ? AND market = ? AND created_at > datetime('now', '-7 days')`,
    [ticker, market]
  );
  let baseScore = existingScores[0]?.total || 0;

  // 1. 연속 BUY 신호 (+10 per consecutive, max +50)
  if (decision.signal === 'BUY') {
    const rec = queryOne(
      "SELECT consecutive_buys FROM recommendations WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
      [ticker, market]
    );
    const consecutive = (rec?.consecutive_buys || 0) + 1;
    execute(
      "UPDATE recommendations SET consecutive_buys = ? WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
      [consecutive, ticker, market]
    );

    const bonus = Math.round(Math.min(consecutive * 10, 50) * (weights.CONSECUTIVE_BUY || 1));
    details.push({ type: 'CONSECUTIVE_BUY', value: bonus, reason: `${consecutive}회 연속 BUY` });
  } else {
    // BUY가 아니면 연속 카운트 리셋
    execute(
      "UPDATE recommendations SET consecutive_buys = 0 WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
      [ticker, market]
    );
  }

  // 2. 신뢰도 기반 점수 (60~100 → 0~20)
  if (decision.confidence >= 60) {
    const confScore = Math.round(((decision.confidence - 60) / 2) * (weights.HIGH_CONFIDENCE || 1));
    details.push({ type: 'HIGH_CONFIDENCE', value: confScore, reason: `신뢰도 ${decision.confidence}%` });
  }

  // 3. 거래량 급증 (+15)
  if (volumeAnalysis && volumeAnalysis.todayVsAvg >= 1.5) {
    details.push({ type: 'VOLUME_SURGE', value: Math.round(15 * (weights.VOLUME_SURGE || 1)), reason: `거래량 ${volumeAnalysis.todayVsAvg.toFixed(1)}배` });
  } else if (volumeAnalysis && volumeAnalysis.volumeTrend === 'INCREASING') {
    details.push({ type: 'VOLUME_SURGE', value: Math.round(5 * (weights.VOLUME_SURGE || 1)), reason: '거래량 증가 추세' });
  }

  // 4. RSI 과매도 반등 (+15)
  if (indicators) {
    if (indicators.rsi14 !== null && indicators.rsi14 >= 30 && indicators.rsi14 <= 40) {
      details.push({ type: 'RSI_OVERSOLD_BOUNCE', value: Math.round(15 * (weights.RSI_OVERSOLD_BOUNCE || 1)), reason: `RSI ${indicators.rsi14.toFixed(1)} 과매도 탈출` });
    }

    // 5. 볼린저 하단 반등 (+10)
    if (indicators.bollingerLower && indicators.bollingerMiddle &&
        indicators.currentPrice > indicators.bollingerLower &&
        indicators.currentPrice < indicators.bollingerMiddle) {
      const distFromLower = ((indicators.currentPrice - indicators.bollingerLower) / indicators.bollingerLower) * 100;
      if (distFromLower < 3) {
        details.push({ type: 'BOLLINGER_BOUNCE', value: Math.round(10 * (weights.BOLLINGER_BOUNCE || 1)), reason: '볼린저 하단 근접 반등' });
      }
    }

    // 6. MACD 골든크로스 (+20)
    if (indicators.macdHistogram && indicators.macdHistogram > 0 && indicators.macd && indicators.macd > 0) {
      details.push({ type: 'MACD_GOLDEN_CROSS', value: Math.round(20 * (weights.MACD_GOLDEN_CROSS || 1)), reason: 'MACD 골든크로스' });
    }
  }

  // 7. 가격 모멘텀 — 강한 상승 추세 감지
  if (decision.urgency === 'IMMEDIATE') {
    details.push({ type: 'PRICE_MOMENTUM', value: Math.round(10 * (weights.PRICE_MOMENTUM || 1)), reason: '즉시 매수 권고' });
  }
  // 5일 연속 양봉 또는 5일 수익률 >5% → 추가 모멘텀 점수
  if (indicators) {
    const sma5 = (indicators as any).sma5 ?? (indicators as any).SMA5;
    const sma20 = (indicators as any).sma20 ?? (indicators as any).SMA20;
    const currentPrice = (indicators as any).currentPrice ?? (indicators as any).close;
    if (sma5 && sma20 && currentPrice) {
      // 5일 이평선이 20일 이평선 위 + 현재가가 5일 이평선 위 → 강한 상승 추세
      if (currentPrice > sma5 && sma5 > sma20) {
        const momentum = Math.round(((currentPrice - sma20) / sma20) * 100);
        if (momentum >= 5) {
          details.push({ type: 'PRICE_MOMENTUM', value: Math.round(15 * (weights.PRICE_MOMENTUM || 1)), reason: `강한 상승 모멘텀 (+${momentum}% vs SMA20)` });
        }
      }
    }
  }

  // 8. 시간 감쇠 — 7일 이상 점수는 감쇠
  const oldScores = queryOne(
    `SELECT SUM(score_value) as old_total FROM recommendation_scores
     WHERE ticker = ? AND market = ? AND created_at <= datetime('now', '-3 days')`,
    [ticker, market]
  );
  if (oldScores?.old_total > 0) {
    const decay = -Math.round(oldScores.old_total * 0.2);
    details.push({ type: 'TIME_DECAY', value: decay, reason: '시간 감쇠' });
  }

  // 9. 뉴스 감성 점수 (긍정 +10, 부정 -10)
  if (sentimentScore !== undefined && sentimentScore !== 0) {
    const sentValue = sentimentScore > 30 ? 10 : sentimentScore < -30 ? -10 : Math.round(sentimentScore / 3);
    const sentLabel = sentimentScore > 30 ? '긍정적' : sentimentScore < -30 ? '부정적' : '중립적';
    details.push({ type: 'NEWS_SENTIMENT' as ScoreType, value: sentValue, reason: `뉴스 감성 ${sentLabel} (${sentimentScore > 0 ? '+' : ''}${sentimentScore})` });
  }

  // 10. 호가 품질 기반 점수
  if (quoteBook) {
    if (quoteBook.quality === 'GOOD') {
      details.push({
        type: 'SPREAD_TIGHT',
        value: Math.round(10 * (weights.SPREAD_TIGHT || 1)),
        reason: `타이트 스프레드 ${quoteBook.spreadPercent.toFixed(2)}%`,
      });
      details.push({
        type: 'BOOK_DEPTH_STRONG',
        value: Math.round(5 * (weights.BOOK_DEPTH_STRONG || 1)),
        reason: `호가 깊이 ${Math.round(quoteBook.topBookDepthKrw / 1_000_000)}M`,
      });
    } else if (quoteBook.quality === 'POOR') {
      details.push({
        type: 'SPREAD_WIDE',
        value: -Math.round(15 * (weights.SPREAD_WIDE || 1)),
        reason: `넓은 스프레드 ${quoteBook.spreadPercent.toFixed(2)}% — 슬리피지 위험`,
      });
    }

    // ── v4.7.0: Quantitative EV penalty ─────────────────────
    //
    // The categorical GOOD/FAIR/POOR bands above only react at thresholds.
    // This block adds a smooth, proportional penalty that reflects the
    // *real* round-trip cost of taking a trade:
    //
    //   total_cost_pct = (½ × spread%) + entry_fee% + exit_fee%
    //
    // ½ × spread because immediate market entry crosses half the spread on
    // the way in and the other half on the way out, but for a single BUY
    // signal we only count the entry leg's worst case + the future exit's
    // expected cost.
    //
    // Korean equity round-trip cost ≈ 0.40% (broker fee + tax + slippage).
    // We convert this percentage cost into a score penalty: each 0.10%
    // above a "free" 0.20% baseline costs 5 points. A clean large-cap
    // (spread 0.05%) → 0 penalty. A POOR-quality small-cap with 0.8%
    // spread → ~30-point penalty stacked on top of SPREAD_WIDE.
    if (decision.signal === 'BUY') {
      const KRX_ROUNDTRIP_FEE_PCT = 0.40;  // 매도세 + 거래세 + 위탁수수료
      const FREE_COST_BUDGET_PCT = 0.20;   // 이 이하의 거래비용은 페널티 없음
      const POINTS_PER_TENTH_PCT = 5;

      const slippageCost = quoteBook.spreadPercent * 0.5;
      const totalCostPct = slippageCost + KRX_ROUNDTRIP_FEE_PCT;
      const excessCost = Math.max(0, totalCostPct - FREE_COST_BUDGET_PCT);

      if (excessCost > 0) {
        const evPenalty = Math.round(excessCost * 10 * POINTS_PER_TENTH_PCT);
        if (evPenalty > 0) {
          details.push({
            type: 'SPREAD_WIDE',
            value: -evPenalty,
            reason: `EV 비용 페널티 ${totalCostPct.toFixed(2)}% (slip ${slippageCost.toFixed(2)} + fee ${KRX_ROUNDTRIP_FEE_PCT.toFixed(2)})`,
          });
        }
      }
    }
  }

  // 이번 라운드 점수 합산
  const roundScore = details.reduce((sum, d) => sum + d.value, 0);

  // DB에 점수 기록
  for (const d of details) {
    execute(
      'INSERT INTO recommendation_scores (ticker, market, score_type, score_value, reason) VALUES (?, ?, ?, ?, ?)',
      [ticker, market, d.type, d.value, d.reason]
    );
  }

  const totalScore = baseScore + roundScore;

  // 추천 테이블 score 업데이트
  execute(
    "UPDATE recommendations SET score = ? WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
    [totalScore, ticker, market]
  );

  // ─── 자동 승격 판정 ──────────────────────────────────────
  let promoted = false;
  let promotedTo: 'watchlist' | 'auto_trade' | undefined;

  const settings = getSettings();
  const autoThreshold = settings.autoTradeScoreThreshold ?? AUTO_TRADE_THRESHOLD;

  if (totalScore >= autoThreshold && settings.autoTradeEnabled) {
    promoted = await promoteToWatchlistAndTrade(ticker, market, totalScore, decision);
    if (promoted) promotedTo = 'auto_trade';
  } else if (totalScore >= WATCHLIST_THRESHOLD) {
    promoted = promoteToWatchlist(ticker, market, totalScore);
    if (promoted) promotedTo = 'watchlist';
  }

  return { totalScore, details, promoted, promotedTo };
}

/** 관심종목으로 승격 */
function promoteToWatchlist(ticker: string, market: string, score: number): boolean {
  // 종목이 DB에 있는지 확인, 없으면 생성
  let stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  if (!stock) {
    const rec = queryOne("SELECT name FROM recommendations WHERE ticker = ? AND status = 'ACTIVE'", [ticker]);
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', [ticker, rec?.name || ticker, normalizeMarket(market)]);
    stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  }

  // 이미 관심종목이면 스킵
  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ? AND deleted_at IS NULL', [stock.id]);
  if (existing) return false;

  // 포트폴리오 규칙 체크
  const stockData = queryOne('SELECT sector FROM stocks WHERE ticker = ?', [ticker]);
  const check = checkPromotionEligibility(ticker, market, stockData?.sector || '');
  if (!check.allowed) {
    logger.info({ ticker, market, reason: check.reason }, 'Promotion blocked by portfolio rules');
    createNotification({
      type: 'PROMOTION',
      title: '승격 보류',
      message: `${ticker} 승격 보류: ${check.reason}`,
      ticker, market, actionUrl: '/recommendations',
    });
    return false;
  }

  // 관심종목 추가
  execute('INSERT INTO watchlist (stock_id, market, notes) VALUES (?, ?, ?)',
    [stock.id, market, `자동승격 (점수: ${score})`]);

  // 추천 상태 업데이트
  execute(
    "UPDATE recommendations SET status = 'EXECUTED' WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
    [ticker, market]
  );

  // 알림 생성
  const rec = queryOne("SELECT name FROM recommendations WHERE ticker = ?", [ticker]);
  createNotification({
    type: 'PROMOTION',
    title: `추천 → 관심종목 승격`,
    message: `${ticker} (${rec?.name || ''})이(가) 누적 점수 ${score}점으로 관심종목에 자동 등록되었습니다.`,
    ticker,
    market,
    actionUrl: '/watchlist',
  });

  logger.info({ ticker, market, score }, 'Promoted to watchlist');
  return true;
}

/** 관심종목 + 자동매매 대상으로 승격 */
async function promoteToWatchlistAndTrade(ticker: string, market: string, score: number, decision: TradeDecision): Promise<boolean> {
  // 먼저 관심종목 추가
  let stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  if (!stock) {
    const rec = queryOne("SELECT name FROM recommendations WHERE ticker = ? AND status = 'ACTIVE'", [ticker]);
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', [ticker, rec?.name || ticker, normalizeMarket(market)]);
    stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  }

  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ? AND deleted_at IS NULL', [stock.id]);

  // 포트폴리오 규칙 체크 (신규 관심종목 추가 시)
  if (!existing) {
    const stockData = queryOne('SELECT sector FROM stocks WHERE ticker = ?', [ticker]);
    const check = checkPromotionEligibility(ticker, market, stockData?.sector || '');
    if (!check.allowed) {
      logger.info({ ticker, market, reason: check.reason }, 'Promotion blocked by portfolio rules');
      createNotification({
        type: 'PROMOTION',
        title: '승격 보류',
        message: `${ticker} 승격 보류: ${check.reason}`,
        ticker, market, actionUrl: '/recommendations',
      });
      return false;
    }
  }

  if (!existing) {
    execute('INSERT INTO watchlist (stock_id, market, notes, auto_trade_enabled) VALUES (?, ?, ?, 1)',
      [stock.id, market, `자동승격+자동매매 (점수: ${score})`]);
  } else {
    execute('UPDATE watchlist SET auto_trade_enabled = 1 WHERE stock_id = ?', [stock.id]);
  }

  // 추천 상태 업데이트
  execute(
    "UPDATE recommendations SET status = 'EXECUTED' WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
    [ticker, market]
  );

  // 매수 신호 기록
  execute(
    'INSERT INTO trade_signals (stock_id, signal_type, source, confidence, llm_reasoning) VALUES (?, ?, ?, ?, ?)',
    [stock.id, 'BUY', 'scoring-auto', decision.confidence,
     `자동승격 매수 (점수: ${score}, 목표가: ${decision.targetPrice}, 손절가: ${decision.stopLossPrice})`]
  );

  // 즉시 매수 실행 (PENDING 대기 대신 직접 실행)
  const rec = queryOne("SELECT name FROM recommendations WHERE ticker = ?", [ticker]);
  try {
    const { executeOrder } = require('./kisOrder');
    const result = await executeOrder({
      stockId: stock.id, ticker, market,
      orderType: 'BUY', quantity: 0, price: 0, signalId: 0,
    });

    if (result.success) {
      createNotification({
        type: 'AUTO_TRADE',
        title: `자동매매 매수 체결`,
        message: `${ticker} (${rec?.name || ''}) ${result.quantity}주 매수 완료 (점수: ${score}, 신뢰도: ${decision.confidence}%)`,
        ticker,
        market,
        actionUrl: '/transactions',
      });
      logger.info({ ticker, market, score, quantity: result.quantity }, 'Auto-trade BUY executed');
    } else {
      // 실행 실패 — PENDING으로 대기 등록 + 실패 사유 기록
      execute(
        'INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [stock.id, 'BUY', 0, decision.entryPrice || 0, 0, 'FAILED', result.message || '실행 실패']
      );
      createNotification({
        type: 'AUTO_TRADE',
        title: `자동매매 실행 실패`,
        message: `${ticker} (${rec?.name || ''}) 매수 실패: ${result.message}`,
        ticker,
        market,
        actionUrl: '/watchlist',
      });
      logger.warn({ ticker, market, score, reason: result.message }, 'Auto-trade BUY failed');
    }
  } catch (err: any) {
    // 예외 발생 — PENDING으로 폴백
    execute(
      'INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [stock.id, 'BUY', 0, decision.entryPrice || 0, 0, 'PENDING', err.message || '']
    );
    createNotification({
      type: 'AUTO_TRADE',
      title: `자동매매 대상 등록 (대기)`,
      message: `${ticker} (${rec?.name || ''}) 점수 ${score}점 — 주문 예약됨 (사유: ${err.message || '실행 오류'})`,
      ticker,
      market,
      actionUrl: '/watchlist',
    });
    logger.error({ err, ticker, market, score }, 'Auto-trade execution error, queued as PENDING');
  }

  logger.info({ ticker, market, score }, 'Promoted to auto-trade');
  return true;
}

/** 추천 종목의 현재 점수 조회 */
export function getRecommendationScore(ticker: string, market: string): number {
  const row = queryOne(
    "SELECT score FROM recommendations WHERE ticker = ? AND market = ? AND status = 'ACTIVE'",
    [ticker, market]
  );
  return row?.score || 0;
}

/** 점수 이력 조회 */
export function getScoreHistory(ticker: string, market: string): any[] {
  return queryAll(
    'SELECT * FROM recommendation_scores WHERE ticker = ? AND market = ? ORDER BY created_at DESC LIMIT 50',
    [ticker, market]
  );
}
