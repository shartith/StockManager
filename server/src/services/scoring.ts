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
import { TradeDecision } from './ollama';
import { createNotification } from './notification';
import { getSettings } from './settings';
import { loadWeights } from './weightOptimizer';

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
  | 'TIME_DECAY';       // 시간 감쇠

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
export function evaluateAndScore(
  ticker: string,
  market: string,
  decision: TradeDecision,
  indicators?: TechnicalIndicators,
  volumeAnalysis?: { avgVolume20d: number; todayVsAvg: number; volumeTrend: string },
): ScoreResult {
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

  // 7. 가격 모멘텀 — LLM urgency가 IMMEDIATE이면 +10
  if (decision.urgency === 'IMMEDIATE') {
    details.push({ type: 'PRICE_MOMENTUM', value: Math.round(10 * (weights.PRICE_MOMENTUM || 1)), reason: '즉시 매수 권고' });
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

  if (totalScore >= AUTO_TRADE_THRESHOLD && getSettings().autoTradeEnabled) {
    promoted = promoteToWatchlistAndTrade(ticker, market, totalScore, decision);
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
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', [ticker, rec?.name || ticker, market]);
    stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  }

  // 이미 관심종목이면 스킵
  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ?', [stock.id]);
  if (existing) return false;

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

  console.log(`[Scoring] 관심종목 승격: ${ticker} (${market}, ${score}점)`);
  return true;
}

/** 관심종목 + 자동매매 대상으로 승격 */
function promoteToWatchlistAndTrade(ticker: string, market: string, score: number, decision: TradeDecision): boolean {
  // 먼저 관심종목 추가
  let stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  if (!stock) {
    const rec = queryOne("SELECT name FROM recommendations WHERE ticker = ? AND status = 'ACTIVE'", [ticker]);
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', [ticker, rec?.name || ticker, market]);
    stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  }

  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ?', [stock.id]);
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

  // 자동매매 주문 대기 등록
  execute(
    'INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status) VALUES (?, ?, ?, ?, ?, ?)',
    [stock.id, 'BUY', 0, decision.entryPrice || 0, 0, 'PENDING']
  );

  // 알림
  const rec = queryOne("SELECT name FROM recommendations WHERE ticker = ?", [ticker]);
  createNotification({
    type: 'AUTO_TRADE',
    title: `자동매매 대상 등록`,
    message: `${ticker} (${rec?.name || ''})이(가) 누적 점수 ${score}점으로 자동매매 대상에 등록되었습니다. 목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}`,
    ticker,
    market,
    actionUrl: '/watchlist',
  });

  console.log(`[Scoring] 자동매매 승격: ${ticker} (${market}, ${score}점)`);
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
