/**
 * 자동매매 스케줄러
 * node-cron 기반, 시장별 현지 시간 스케줄링
 * 주말 제외, 4개 시점: 장 시작 전, 장 시작 30분 후, 장 마감 1시간 전, 장 마감 30분 전
 */

import cron from 'node-cron';
import { getSettings, MarketScheduleConfig } from './settings';
import { queryAll, queryOne, execute } from '../db';
import { analyzeTechnical, CandleData } from './technicalAnalysis';
import { getTradeDecision, buildAnalysisInput, AnalysisPhase } from './ollama';
import { collectAndCacheNews, getCachedNews, summarizeNewsWithAI } from './newsCollector';
import { getAccessToken, getKisConfig } from './kisAuth';
import { evaluateAndScore } from './scoring';
import { executeOrder, getCurrentPrice, getHoldingQuantity, calculateOrderQuantity } from './kisOrder';
import { createNotification } from './notification';
import { registerSignalForTracking, evaluatePendingPerformance } from './performanceTracker';
import { optimizeWeights } from './weightOptimizer';
import { getPortfolioRiskContext } from './calculator';
import { getMultipleStockPrices, getMarketContext, formatMarketContext } from './stockPrice';
import { kisApiCall } from './apiQueue';
import { getKisFundamentals } from './stockPrice';
import { getInvestorFlow } from './investorFlow';
import { getLoraDataCount, generateLoraDataset } from './exportImport';
import { getDartDisclosures } from './dartApi';
import { logSystemEvent } from './systemEvent';
import { manageUnfilledOrders, checkReservedOrders, createReservedOrder } from './orderManager';

type SchedulePhase = 'PRE_OPEN' | 'POST_OPEN' | 'PRE_CLOSE_1H' | 'PRE_CLOSE_30M' | 'MARKET_OPEN' | 'INTRADAY' | 'PROFIT_TAKING';
type Market = 'KRX' | 'NYSE' | 'NASDAQ';

const activeTasks: any[] = [];

interface ScheduleLog {
  market: Market;
  phase: SchedulePhase;
  timestamp: string;
  status: 'started' | 'completed' | 'error';
  message: string;
}

const recentLogs: ScheduleLog[] = [];
const MAX_LOGS = 100;

function addLog(market: Market, phase: SchedulePhase, status: ScheduleLog['status'], message: string) {
  recentLogs.unshift({
    market,
    phase,
    timestamp: new Date().toISOString(),
    status,
    message,
  });
  if (recentLogs.length > MAX_LOGS) recentLogs.length = MAX_LOGS;
  console.log(`[Scheduler] [${market}] [${phase}] ${status}: ${message}`);
}

export function getSchedulerLogs(): ScheduleLog[] {
  return recentLogs;
}

// 가격 캐시 (연속 모니터링용 — 전회 시세와 비교)
const priceCache = new Map<string, number>();

/** 스케줄러 시작 */
export function startScheduler() {
  stopScheduler();
  const settings = getSettings();

  // ── KRX 연속 모니터링 (Asia/Seoul, 월~금) ──
  if (settings.scheduleKrx.enabled) {
    // 장 시작 10분 관망 후: 뉴스 수집 + 갭 분석 + 초기 매수
    activeTasks.push(cron.schedule('10 9 * * 1-5', () => runMarketOpen('KRX'), { timezone: 'Asia/Seoul' }));
    // 장 중: 10분 간격 연속 모니터링 (09:20~14:50)
    activeTasks.push(cron.schedule('*/10 9-14 * * 1-5', () => runContinuousMonitor('KRX'), { timezone: 'Asia/Seoul' }));
    // 장 마감 30분 전: 수익 실현 매도
    activeTasks.push(cron.schedule('0 15 * * 1-5', () => runProfitTaking('KRX'), { timezone: 'Asia/Seoul' }));
    console.log('[Scheduler] KRX 연속 모니터링 등록 (09:10 관망 후 → 10분 간격 → 15:00 수익실현)');
  }

  // ── NYSE/NASDAQ 연속 모니터링 (America/New_York, 월~금) ──
  if (settings.scheduleNyse.enabled) {
    // 장 시작 10분 관망 후: 뉴스 + 갭 분석 + 초기 매수
    activeTasks.push(cron.schedule('40 9 * * 1-5', () => runMarketOpen('NYSE'), { timezone: 'America/New_York' }));
    // 장 중: 10분 간격 연속 모니터링 (09:50~15:20)
    activeTasks.push(cron.schedule('*/10 9-15 * * 1-5', () => runContinuousMonitor('NYSE'), { timezone: 'America/New_York' }));
    // 장 마감 30분 전: 수익 실현 매도
    activeTasks.push(cron.schedule('30 15 * * 1-5', () => runProfitTaking('NYSE'), { timezone: 'America/New_York' }));
    console.log('[Scheduler] NYSE 연속 모니터링 등록 (09:40 관망 후 → 10분 간격 → 15:30 수익실현)');
  }

  // ── 추천종목 자동 갱신 (매 시간) ──
  if (settings.ollamaEnabled) {
    activeTasks.push(cron.schedule('0 * * * *', () => runRecommendationRefresh(), { timezone: 'Asia/Seoul' }));
    console.log('[Scheduler] 추천종목 자동 갱신 스케줄 등록 (매 1시간)');
  }

  // ── DART 공시 감시 (10분 간격, KRX 장 시간) ──
  if (settings.dartEnabled && settings.dartApiKey) {
    activeTasks.push(cron.schedule('*/10 9-15 * * 1-5', () => checkDartDisclosures(), { timezone: 'Asia/Seoul' }));
    console.log('[Scheduler] DART 공시 감시 스케줄 등록 (10분 간격, 09~15시)');
  }

  // ── 일일 성과 평가 (18:00 KST, 평일) ──
  activeTasks.push(cron.schedule('0 18 * * 1-5', async () => {
    try { await evaluatePendingPerformance(); } catch (err: any) {
      console.log(`[Scheduler] 성과 평가 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' }));
  console.log('[Scheduler] 일일 성과 평가 스케줄 등록 (18:00 KST)');

  // ── 관심종목 자동 정리 (22:00 KST, 매일) ──
  activeTasks.push(cron.schedule('0 22 * * *', () => cleanupWatchlist(), { timezone: 'Asia/Seoul' }));
  console.log('[Scheduler] 관심종목 자동 정리 스케줄 등록 (22:00 KST)');

  // ── 주말 학습 (토요일 06:00 KST) ──
  activeTasks.push(cron.schedule('0 6 * * 6', () => runWeekendLearning(), { timezone: 'Asia/Seoul' }));
  console.log('[Scheduler] 주말 학습 스케줄 등록 (토요일 06:00 KST)');

  if (activeTasks.length > 0) {
    console.log(`[Scheduler] 총 ${activeTasks.length}개 스케줄 활성화`);
  } else {
    console.log('[Scheduler] 활성화된 스케줄 없음');
  }
}

/** 스케줄러 중지 */
export function stopScheduler() {
  activeTasks.forEach(task => task.stop());
  activeTasks.length = 0;
  console.log('[Scheduler] 모든 스케줄 중지');
}

/** 스케줄러 상태 */
export function getSchedulerStatus() {
  const settings = getSettings();
  return {
    active: activeTasks.length > 0,
    taskCount: activeTasks.length,
    krxEnabled: settings.scheduleKrx.enabled,
    nyseEnabled: settings.scheduleNyse.enabled,
    autoTradeEnabled: settings.autoTradeEnabled,
    recentLogs: recentLogs.slice(0, 20),
  };
}

// ─── 유틸리티 함수 ──────────────────────────────────────

/** 시장별 관련 마켓 코드 목록 (NYSE → NASDAQ/AMEX 포함) */
function getMarketList(market: Market): string[] {
  return market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
}

/** 모니터링 대상 종목 조회 (관심종목 + 보유종목) */
function getMonitorTargets(market: Market): any[] {
  const markets = getMarketList(market);
  const ph = markets.map(() => '?').join(',');
  return queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name, s.market FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE s.market IN (${ph})
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, markets);
}

// ─── 이전 4단계 핸들러는 연속 모니터링으로 대체됨 ────────────────
// runPhase, handlePreOpen, handlePostOpen, handlePreClose1h, handlePreClose30m → 제거
// 대체: runMarketOpen, runContinuousMonitor, runProfitTaking

// [레거시] runPhase + 4단계 핸들러 — 연속 모니터링으로 대체됨 (호환성 유지)
async function runPhase(market: Market, phase: SchedulePhase) {
  addLog(market, phase, 'started', `${phase} 시작`);

  try {
    // 관심종목 + 보유종목 중 해당 시장 종목 가져오기
    // NYSE 스케줄은 NASDAQ, AMEX 종목도 포함 (미국 시장 동일 시간대)
    const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
    const placeholders = markets.map(() => '?').join(',');

    const watchlistStocks = queryAll(
      `SELECT s.id, s.ticker, s.name, s.market, w.auto_trade_enabled
       FROM watchlist w
       JOIN stocks s ON s.id = w.stock_id
       WHERE w.market IN (${placeholders})`,
      markets
    );

    const holdingStocks = queryAll(
      `SELECT DISTINCT s.id, s.ticker, s.name, s.market
       FROM stocks s
       JOIN transactions t ON t.stock_id = s.id
       WHERE s.market IN (${placeholders})
       GROUP BY s.id
       HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END) > 0`,
      markets
    );

    // 중복 제거
    const stockMap = new Map<number, any>();
    for (const s of [...watchlistStocks, ...holdingStocks]) {
      if (!stockMap.has(s.id)) stockMap.set(s.id, s);
    }
    const stocks = Array.from(stockMap.values());

    if (stocks.length === 0) {
      addLog(market, phase, 'completed', '분석 대상 종목 없음');
      return;
    }

    switch (phase) {
      case 'PRE_OPEN':
        await handlePreOpen(market, stocks);
        break;
      case 'POST_OPEN':
        await handlePostOpen(market, stocks);
        break;
      case 'PRE_CLOSE_1H':
        await handlePreClose1h(market, stocks);
        break;
      case 'PRE_CLOSE_30M':
        await handlePreClose30m(market, stocks);
        break;
    }

    addLog(market, phase, 'completed', `${stocks.length}개 종목 처리 완료`);
  } catch (err: any) {
    addLog(market, phase, 'error', err.message || '알 수 없는 오류');
  }
}

/** 종목의 보유 현황 조회 */
function getHoldingInfo(stockId: number, currentPrice: number) {
  const row = queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END),0) as buy_qty,
      COALESCE(SUM(CASE WHEN t.type='SELL' THEN t.quantity ELSE 0 END),0) as sell_qty,
      COALESCE(SUM(CASE WHEN t.type='BUY' THEN t.quantity * t.price ELSE 0 END),0) as buy_cost,
      MIN(t.date) as first_date
    FROM transactions t WHERE t.stock_id = ?
  `, [stockId]);

  if (!row || row.buy_qty <= row.sell_qty) return undefined;

  const quantity = row.buy_qty - row.sell_qty;
  const avgPrice = row.buy_qty > 0 ? row.buy_cost / row.buy_qty : 0;
  const totalCost = avgPrice * quantity;
  const currentValue = currentPrice * quantity;
  const holdingDays = row.first_date
    ? Math.floor((Date.now() - new Date(row.first_date).getTime()) / 86400000)
    : 0;

  return {
    quantity,
    avgPrice: Math.round(avgPrice),
    totalCost: Math.round(totalCost),
    unrealizedPnL: Math.round(currentValue - totalCost),
    unrealizedPnLPercent: totalCost > 0 ? Math.round(((currentValue - totalCost) / totalCost) * 10000) / 100 : 0,
    holdingDays,
  };
}

/** 공통: 종목 분석 + LLM 판단 */
async function analyzeStock(stock: any, market: Market, phase: AnalysisPhase, candles: CandleData[], newsSummary?: string, sentimentScore?: number, marketContextStr?: string, intradayData?: { trend: 'UP' | 'DOWN' | 'FLAT'; shortRsi: number | null }) {
  const indicators = analyzeTechnical(candles);
  const holding = getHoldingInfo(stock.id, indicators.currentPrice);

  const input = buildAnalysisInput(
    stock.ticker,
    stock.name,
    market as any,
    candles,
    indicators,
    holding,
    newsSummary,
  );

  // 감성 점수 추가
  if (sentimentScore !== undefined) input.sentimentScore = sentimentScore;

  // 시장 컨텍스트 추가
  if (marketContextStr) input.marketContext = marketContextStr;

  // 분봉 단기 추세 추가
  if (intradayData) input.intradayTrend = intradayData;

  // 갭 분석 추가
  if (candles.length >= 2) {
    const prevClose = candles[candles.length - 2].close;
    const todayOpen = candles[candles.length - 1].open;
    const gapPercent = Math.round(((todayOpen - prevClose) / prevClose) * 10000) / 100;
    input.gapAnalysis = {
      prevClose, todayOpen, gapPercent,
      gapType: gapPercent >= 1 ? 'GAP_UP' : gapPercent <= -1 ? 'GAP_DOWN' : 'FLAT',
    };
  }

  // 재무 데이터 + 수급 데이터 추가
  try {
    const fundamentals = await getKisFundamentals(stock.ticker);
    if (fundamentals && (fundamentals.per || fundamentals.pbr)) input.fundamentals = fundamentals;
  } catch {}
  try {
    const flow = await getInvestorFlow(stock.ticker, stock.market || market);
    if (flow) input.investorFlow = flow;
  } catch {}

  // 포트폴리오 리스크 컨텍스트 추가
  try {
    input.portfolioContext = getPortfolioRiskContext();
  } catch {}

  let decision;
  try {
    decision = await getTradeDecision(input, phase);
  } catch (llmErr: any) {
    // Ollama 다운 → 기술적 분석만으로 fallback 판단
    await logSystemEvent('WARN', 'OLLAMA_DOWN',
      `LLM 연결 실패 — 기술적 분석 fallback: ${stock.ticker}`,
      llmErr.message, stock.ticker);

    const techSignal = input.indicators.technicalSignal;
    decision = {
      signal: techSignal,
      confidence: techSignal === 'HOLD' ? 30 : 50, // fallback은 낮은 신뢰도
      targetPrice: null, stopLossPrice: null, entryPrice: null,
      suggestedRatio: 30, urgency: 'NO_RUSH' as const,
      reasoning: `[LLM 미연결 fallback] 기술적 분석 기반: ${input.indicators.technicalReasons.join(', ')}`,
      keyFactors: input.indicators.technicalReasons,
      risks: ['LLM 미연결로 인한 제한적 분석'],
      holdingPeriod: 'SHORT_TERM' as const,
    };
  }

  // trade_signals에 저장
  const { lastId: signalId } = execute(
    'INSERT INTO trade_signals (stock_id, signal_type, source, confidence, indicators_json, llm_reasoning) VALUES (?, ?, ?, ?, ?, ?)',
    [stock.id, decision.signal, `ollama-${phase}`, decision.confidence, JSON.stringify({
      indicators: input.indicators,
      volumeAnalysis: input.volumeAnalysis,
      targetPrice: decision.targetPrice,
      stopLossPrice: decision.stopLossPrice,
      entryPrice: decision.entryPrice,
      keyFactors: decision.keyFactors,
      risks: decision.risks,
    }), decision.reasoning]
  );

  // 성과 추적 등록
  if (signalId > 0) {
    registerSignalForTracking(signalId);
  }

  // WAIT_DIP 판단 → 예약 매수 생성
  if (decision.signal === 'BUY' && decision.urgency === 'WAIT_DIP' && decision.entryPrice) {
    createReservedOrder(
      stock.id, stock.ticker, stock.market || market,
      'BUY', decision.entryPrice, 'BELOW', 0,
      `LLM WAIT_DIP: ${decision.reasoning?.slice(0, 100)}`
    );
  }

  return decision;
}

/** 장 시작 전: 뉴스 수집 + AI 요약 + 기술지표 → Ollama 매수 판단 */
async function handlePreOpen(market: Market, stocks: any[]) {
  const settings = getSettings();

  for (const stock of stocks) {
    try {
      // 1. 뉴스 수집 + AI 요약
      const news = await collectAndCacheNews(stock.ticker, stock.name, market);
      let newsSummary: string | undefined;
      let sentimentScore: number | undefined;
      if (news.length > 0) {
        const sentiment = await summarizeNewsWithAI(news, stock.ticker);
        newsSummary = sentiment.summary;
        sentimentScore = sentiment.sentimentScore;
      }

      // 2. 캔들 + 기술 분석 + LLM 판단
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      if (settings.ollamaEnabled) {
        const decision = await analyzeStock(stock, market, 'PRE_OPEN', candles, newsSummary, sentimentScore);
        addLog(market, 'PRE_OPEN', 'completed',
          `${stock.ticker}: ${decision.signal} (신뢰도 ${decision.confidence}%) — ${decision.reasoning.slice(0, 60)}`);
      }
    } catch (err: any) {
      addLog(market, 'PRE_OPEN', 'error', `${stock.ticker}: ${err.message}`);
    }

    await sleep(100);
  }
}

/** 장 시작 30분 후: 시초가 확인 + 매수 주문 실행 */
async function handlePostOpen(market: Market, stocks: any[]) {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    addLog(market, 'POST_OPEN', 'completed', '자동매매 비활성화 — 주문 스킵');
    return;
  }

  // 오늘 BUY 신호 조회: 관심종목(auto_trade) + 보유종목 모두 포함
  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');
  const buySignals = queryAll(
    `SELECT ts.*, s.ticker, s.name, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     WHERE ts.signal_type = 'BUY'
     AND ts.confidence >= 60
     AND date(ts.created_at) = date('now')
     AND s.market IN (${ph})
     AND (
       EXISTS (SELECT 1 FROM watchlist w WHERE w.stock_id = s.id AND w.auto_trade_enabled = 1)
       OR EXISTS (
         SELECT 1 FROM transactions t WHERE t.stock_id = s.id
         GROUP BY t.stock_id
         HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
       )
     )
     ORDER BY ts.confidence DESC`,
    markets
  );

  for (const signal of buySignals) {
    // 이미 오늘 이 종목에 주문했는지 확인
    const alreadyOrdered = queryOne(
      "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now') AND status IN ('SUBMITTED', 'FILLED')",
      [signal.stock_id]
    );
    if (alreadyOrdered) continue;

    try {
      const result = await executeOrder({
        stockId: signal.stock_id,
        ticker: signal.ticker,
        market: market as any,
        orderType: 'BUY',
        quantity: 0, // 자동 계산
        price: 0,    // 시장가
        signalId: signal.id,
      });

      if (result.success) {
        addLog(market, 'POST_OPEN', 'completed',
          `매수 체결: ${signal.ticker} ${result.quantity}주 @ ${result.price.toLocaleString()} (${result.kisOrderNo})`);

        createNotification({
          type: 'AUTO_TRADE',
          title: `자동매수 체결`,
          message: `${signal.ticker} (${signal.name}) ${result.quantity}주를 ${result.price.toLocaleString()}원에 매수했습니다. (신뢰도 ${signal.confidence}%)`,
          ticker: signal.ticker,
          market,
          actionUrl: '/transactions',
        });
      } else {
        addLog(market, 'POST_OPEN', 'completed', `매수 실패: ${signal.ticker} — ${result.message}`);
      }
    } catch (err: any) {
      addLog(market, 'POST_OPEN', 'error', `매수 오류: ${signal.ticker} — ${err.message}`);
    }

    // Rate limit은 apiQueue에서 관리
  }
}

/** 장 마감 1시간 전: 보유종목 재평가 + Ollama 매도 판단 */
async function handlePreClose1h(market: Market, stocks: any[]) {
  const settings = getSettings();

  // 보유 종목만 필터
  const holdingIds = queryAll(
    `SELECT DISTINCT s.id, s.ticker, s.name
     FROM stocks s
     JOIN transactions t ON t.stock_id = s.id
     WHERE s.market = ?
     GROUP BY s.id
     HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END) > 0`,
    [market]
  );

  for (const stock of holdingIds) {
    try {
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      let newsSummary: string | undefined;
      const cachedNews = getCachedNews(stock.ticker);
      if (cachedNews.length > 0) {
        const sentiment = await summarizeNewsWithAI(cachedNews, stock.ticker);
        newsSummary = sentiment.summary;
      }

      if (settings.ollamaEnabled) {
        const decision = await analyzeStock(stock, market, 'PRE_CLOSE_1H', candles, newsSummary);
        addLog(market, 'PRE_CLOSE_1H', 'completed',
          `${stock.ticker}: ${decision.signal} (신뢰도 ${decision.confidence}%) — ${decision.reasoning.slice(0, 60)}`);
      }
    } catch (err: any) {
      addLog(market, 'PRE_CLOSE_1H', 'error', `${stock.ticker}: ${err.message}`);
    }

    await sleep(100);
  }
}

/** 장 마감 30분 전: 매도 주문 실행 + 일일 리포트 */
async function handlePreClose30m(market: Market, stocks: any[]) {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    addLog(market, 'PRE_CLOSE_30M', 'completed', '자동매매 비활성화 — 주문 스킵');
    return;
  }

  // 오늘 SELL 신호 조회: 보유종목 전체 대상
  const sellMarkets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const sellPh = sellMarkets.map(() => '?').join(',');
  const sellSignals = queryAll(
    `SELECT ts.*, s.ticker, s.name, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     WHERE ts.signal_type = 'SELL'
     AND ts.confidence >= 60
     AND date(ts.created_at) = date('now')
     AND s.market IN (${sellPh})
     AND EXISTS (
       SELECT 1 FROM transactions t WHERE t.stock_id = s.id
       GROUP BY t.stock_id
       HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
     )
     ORDER BY ts.confidence DESC`,
    sellMarkets
  );

  for (const signal of sellSignals) {
    // 보유 수량 확인
    const holdingQty = getHoldingQuantity(signal.stock_id);
    if (holdingQty <= 0) {
      addLog(market, 'PRE_CLOSE_30M', 'completed', `매도 스킵: ${signal.ticker} — 보유 수량 없음`);
      continue;
    }

    // 이미 오늘 이 종목에 매도 주문했는지 확인
    const alreadyOrdered = queryOne(
      "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'SELL' AND date(created_at) = date('now') AND status IN ('SUBMITTED', 'FILLED')",
      [signal.stock_id]
    );
    if (alreadyOrdered) continue;

    try {
      const result = await executeOrder({
        stockId: signal.stock_id,
        ticker: signal.ticker,
        market: market as any,
        orderType: 'SELL',
        quantity: holdingQty, // 전량 매도
        price: 0,             // 시장가
        signalId: signal.id,
      });

      if (result.success) {
        addLog(market, 'PRE_CLOSE_30M', 'completed',
          `매도 체결: ${signal.ticker} ${result.quantity}주 @ ${result.price.toLocaleString()} (${result.kisOrderNo})`);

        createNotification({
          type: 'AUTO_TRADE',
          title: `자동매도 체결`,
          message: `${signal.ticker} (${signal.name}) ${result.quantity}주를 ${result.price.toLocaleString()}원에 매도했습니다. (신뢰도 ${signal.confidence}%)`,
          ticker: signal.ticker,
          market,
          actionUrl: '/transactions',
        });
      } else {
        addLog(market, 'PRE_CLOSE_30M', 'completed', `매도 실패: ${signal.ticker} — ${result.message}`);
      }
    } catch (err: any) {
      addLog(market, 'PRE_CLOSE_30M', 'error', `매도 오류: ${signal.ticker} — ${err.message}`);
    }

    await sleep(500);
  }

  // 일일 리포트
  const todaySignals = queryAll(
    "SELECT signal_type, COUNT(*) as cnt FROM trade_signals WHERE date(created_at) = date('now') GROUP BY signal_type"
  );
  const todayTrades = queryAll(
    "SELECT order_type, status, COUNT(*) as cnt FROM auto_trades WHERE date(created_at) = date('now') GROUP BY order_type, status"
  );
  const signalSummary = todaySignals.map((s: any) => `${s.signal_type}: ${s.cnt}건`).join(', ');
  const tradeSummary = todayTrades.map((t: any) => `${t.order_type}(${t.status}): ${t.cnt}건`).join(', ');
  addLog(market, 'PRE_CLOSE_30M', 'completed', `일일 리포트 — 신호[${signalSummary || '없음'}] 주문[${tradeSummary || '없음'}]`);

  // 일일 리포트 알림
  if (todayTrades.length > 0) {
    createNotification({
      type: 'INFO',
      title: `${market} 일일 거래 리포트`,
      message: `신호: ${signalSummary || '없음'} / 주문: ${tradeSummary || '없음'}`,
      market,
      actionUrl: '/transactions',
    });
  }
}

/** KIS API로 캔들 데이터 조회 (국내/해외 분기) */
async function fetchCandleData(ticker: string, market: Market): Promise<CandleData[] | null> {
  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    if (!appKey || !appSecret) return null;

    const token = await getAccessToken();
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(today);
    startDate.setMonth(startDate.getMonth() - 6);
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');

    if (market === 'KRX') {
      return await fetchDomesticCandles(ticker, token, appKey, appSecret, baseUrl, start, end);
    } else {
      return await fetchOverseasCandles(ticker, market, token, appKey, appSecret, baseUrl, start, end, isVirtual);
    }
  } catch {
    return null;
  }
}

/** 국내주식 일봉 조회 */
async function fetchDomesticCandles(
  ticker: string, token: string, appKey: string, appSecret: string,
  baseUrl: string, start: string, end: string,
): Promise<CandleData[] | null> {
  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: ticker,
    fid_input_date_1: start,
    fid_input_date_2: end,
    fid_period_div_code: 'D',
    fid_org_adj_prc: '0',
  });

  const response = await fetch(
    `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHKST03010100',
        custtype: 'P',
      },
    }
  );

  if (!response.ok) return null;
  const data: any = await response.json();
  if (data.rt_cd !== '0') return null;

  return (data.output2 || [])
    .filter((item: any) => item.stck_bsop_date && Number(item.stck_oprc) > 0)
    .map((item: any) => ({
      time: `${item.stck_bsop_date.slice(0, 4)}-${item.stck_bsop_date.slice(4, 6)}-${item.stck_bsop_date.slice(6, 8)}`,
      open: Number(item.stck_oprc),
      high: Number(item.stck_hgpr),
      low: Number(item.stck_lwpr),
      close: Number(item.stck_clpr),
      volume: Number(item.acml_vol),
    }))
    .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
}

/** 해외주식 일봉 조회 (KIS API HHDFS76240000) */
async function fetchOverseasCandles(
  ticker: string, market: Market, token: string, appKey: string, appSecret: string,
  baseUrl: string, start: string, end: string, isVirtual: boolean,
): Promise<CandleData[] | null> {
  // 거래소 코드: NYS(뉴욕), NAS(나스닥), AMS(아멕스)
  const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
  const trId = isVirtual ? 'VHHDFS76240000' : 'HHDFS76240000';

  const params = new URLSearchParams({
    AUTH: '',
    EXCD: exchCode,
    SYMB: ticker,
    GUBN: '0',       // 0: 일봉
    BYMD: end,
    MODP: '1',       // 수정주가
  });

  const response = await fetch(
    `${baseUrl}/uapi/overseas-price/v1/quotations/dailyprice?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: trId,
        custtype: 'P',
      },
    }
  );

  if (!response.ok) return null;
  const data: any = await response.json();
  if (data.rt_cd !== '0') return null;

  return (data.output2 || [])
    .filter((item: any) => item.xymd && Number(item.open) > 0)
    .map((item: any) => ({
      time: `${item.xymd.slice(0, 4)}-${item.xymd.slice(4, 6)}-${item.xymd.slice(6, 8)}`,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.clos),
      volume: Number(item.tvol),
    }))
    .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
}

/** 국내주식 분봉(5분봉) 조회 — 장중 단기 추세 분석용 */
async function fetchIntradayCandles(ticker: string, market: string): Promise<{ trend: 'UP' | 'DOWN' | 'FLAT'; shortRsi: number | null; data: CandleData[] }> {
  const defaultResult = { trend: 'FLAT' as const, shortRsi: null, data: [] };
  if (market !== 'KRX') return defaultResult; // 해외는 분봉 미지원

  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    const token = await getAccessToken();
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0') + '00';

    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
      fid_input_hour_1: timeStr,
      fid_pw_data_incu_yn: 'N',
      fid_etc_cls_code: '5', // 5분봉
    });

    const trId = isVirtual ? 'FHKST03010200' : 'FHKST03010200';
    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: trId, custtype: 'P',
        },
      }
    );

    if (!response.ok) return defaultResult;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return defaultResult;

    const candles: CandleData[] = (data.output2 || [])
      .filter((item: any) => item.stck_cntg_hour && Number(item.stck_oprc) > 0)
      .slice(0, 30)
      .map((item: any) => ({
        time: item.stck_cntg_hour,
        open: Number(item.stck_oprc),
        high: Number(item.stck_hgpr),
        low: Number(item.stck_lwpr),
        close: Number(item.stck_prpr),
        volume: Number(item.cntg_vol),
      }));

    if (candles.length < 10) return defaultResult;

    // 단기 추세 판단: 최근 5개 vs 이전 5개 평균 close 비교
    const recent5 = candles.slice(0, 5).reduce((s, c) => s + c.close, 0) / 5;
    const prev5 = candles.slice(5, 10).reduce((s, c) => s + c.close, 0) / 5;
    const trendRatio = (recent5 - prev5) / prev5 * 100;
    const trend = trendRatio > 0.3 ? 'UP' : trendRatio < -0.3 ? 'DOWN' : 'FLAT';

    // 단기 RSI (14개 분봉 기준)
    const closes = candles.map(c => c.close).reverse();
    const { calcRSI } = require('./technicalAnalysis');
    const shortRsi = closes.length >= 15 ? calcRSI(closes, 14) : null;

    return { trend, shortRsi, data: candles };
  } catch {
    return defaultResult;
  }
}

/** 국내주식 거래량 상위 종목 검색 */
async function fetchDomesticVolumeRank(appKey: string, appSecret: string, baseUrl: string): Promise<{ticker: string; name: string}[]> {
  try {
    const token = await getAccessToken();
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_cond_scr_div_code: '20171',
      fid_input_iscd: '0000',
      fid_div_cls_code: '0',
      fid_blng_cls_code: '0',
      fid_trgt_cls_code: '111111111',
      fid_trgt_exls_cls_code: '000000',
      fid_input_price_1: '0',
      fid_input_price_2: '0',
      fid_vol_cnt: '0',
      fid_input_date_1: '',
    });

    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHPST01710000',
          custtype: 'P',
        },
      }
    );

    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];

    return (data.output || []).slice(0, 30).map((item: any) => ({
      ticker: item.mksc_shrn_iscd || item.stck_shrn_iscd || '',
      name: item.hts_kor_isnm || '',
    })).filter((c: any) => c.ticker);
  } catch {
    return [];
  }
}

/** 해외주식 거래량 상위 종목 검색 */
async function fetchOverseasVolumeRank(market: Market): Promise<{ticker: string; name: string}[]> {
  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    if (!appKey || !appSecret) return [];

    const token = await getAccessToken();
    const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
    const trId = isVirtual ? 'VHHDFS76410000' : 'HHDFS76410000';

    // 해외주식 조건검색 (거래량 상위)
    const params = new URLSearchParams({
      AUTH: '',
      EXCD: exchCode,
      CO_YN_PRICECUR: '',
      CO_ST_PRICECUR: '',
      CO_EN_PRICECUR: '',
      CO_YN_RATE: '',
      CO_ST_RATE: '',
      CO_EN_RATE: '',
      CO_YN_VALX: '',
      CO_ST_VALX: '',
      CO_EN_VALX: '',
      CO_YN_SHAR: '',
      CO_ST_SHAR: '',
      CO_EN_SHAR: '',
      CO_YN_VOLUME: 'Y',
      CO_ST_VOLUME: '100000',
      CO_EN_VOLUME: '',
      CO_YN_AMT: '',
      CO_ST_AMT: '',
      CO_EN_AMT: '',
      CO_YN_EPS: '',
      CO_ST_EPS: '',
      CO_EN_EPS: '',
      CO_YN_PER: '',
      CO_ST_PER: '',
      CO_EN_PER: '',
    });

    const response = await fetch(
      `${baseUrl}/uapi/overseas-price/v1/quotations/inquire-search?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      }
    );

    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];

    return (data.output2 || []).slice(0, 30).map((item: any) => ({
      ticker: item.symb || '',
      name: item.name || item.symb || '',
    })).filter((c: any) => c.ticker);
  } catch {
    return [];
  }
}

/** 추천종목 자동 갱신 (매 1시간, 24시간 운영)
 * 1) 기존 ACTIVE 추천 재검증 — BUY 아니면 제외
 * 2) 포트폴리오 보유 종목 제외
 * 3) 빈 슬롯이 있으면 거래량 상위에서 신규 후보 탐색
 * 시장별 최대 10개
 */
async function runRecommendationRefresh() {
  const MAX_PER_MARKET = 10;
  const settings = getSettings();
  if (!settings.ollamaEnabled) return;

  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret) {
    console.log('[Scheduler] 추천 갱신 스킵: KIS API 미설정');
    return;
  }

  const markets: Market[] = ['KRX', 'NYSE', 'NASDAQ'];

  for (const market of markets) {
    console.log(`[Scheduler] 추천종목 갱신 시작: ${market}`);

    // 포트폴리오 보유 종목
    const holdingTickers = new Set(
      queryAll(`
        SELECT DISTINCT s.ticker FROM stocks s
        JOIN transactions t ON t.stock_id = s.id
        WHERE s.market = ?
        GROUP BY s.id
        HAVING SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type='SELL' THEN t.quantity ELSE 0 END) > 0
      `, [market]).map((r: any) => r.ticker)
    );

    // 관심종목 티커 (추천에서 제외 대상)
    const watchlistTickers = new Set(
      queryAll(`
        SELECT s.ticker FROM watchlist w
        JOIN stocks s ON s.id = w.stock_id
        WHERE w.market = ?
      `, [market]).map((r: any) => r.ticker)
    );

    // Step 1: 기존 추천 재검증
    const activeRecs = queryAll(
      "SELECT * FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]
    );

    for (const rec of activeRecs) {
      if (holdingTickers.has(rec.ticker)) {
        execute("UPDATE recommendations SET status = 'DISMISSED' WHERE id = ?", [rec.id]);
        console.log(`[Scheduler] 추천 제외 (보유 중): ${rec.ticker}`);
        continue;
      }

      // 이미 관심종목에 있으면 추천에서 제외
      if (watchlistTickers.has(rec.ticker)) {
        execute("UPDATE recommendations SET status = 'EXECUTED' WHERE id = ?", [rec.id]);
        console.log(`[Scheduler] 추천 제외 (관심종목): ${rec.ticker}`);
        continue;
      }

      try {
        const candles = await fetchCandleData(rec.ticker, market);
        if (!candles || candles.length < 30) {
          execute("UPDATE recommendations SET status = 'EXPIRED' WHERE id = ?", [rec.id]);
          continue;
        }

        const indicators = analyzeTechnical(candles);
        const input = buildAnalysisInput(rec.ticker, rec.name, market as any, candles, indicators);
        const decision = await getTradeDecision(input, 'PRE_OPEN');

        if (decision.signal !== 'BUY' || decision.confidence < 60) {
          execute("UPDATE recommendations SET status = 'EXPIRED' WHERE id = ?", [rec.id]);
          console.log(`[Scheduler] 추천 제거: ${rec.ticker} (${decision.signal}, ${decision.confidence}%)`);
        } else {
          const reason = `${decision.reasoning} [목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}]`;
          execute("UPDATE recommendations SET confidence = ?, reason = ? WHERE id = ?", [decision.confidence, reason, rec.id]);

          // 스코어링 평가
          const scoreResult = evaluateAndScore(rec.ticker, market, decision, indicators, input.volumeAnalysis);
          if (scoreResult.promoted) {
            console.log(`[Scheduler] 자동 승격: ${rec.ticker} → ${scoreResult.promotedTo} (${scoreResult.totalScore}점)`);
          }
        }
      } catch (err: any) {
        console.log(`[Scheduler] 추천 검증 오류: ${rec.ticker} — ${err.message}`);
      }
      await sleep(200);
    }

    // Step 2: 빈 슬롯 채우기 — 거래량 상위 검색
    const currentCount = queryAll(
      "SELECT id FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]
    ).length;
    let slotsAvailable = MAX_PER_MARKET - currentCount;

    if (slotsAvailable > 0) {
      const activeTickers = new Set(
        queryAll("SELECT ticker FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market])
          .map((r: any) => r.ticker)
      );

      // 시장별 후보 검색
      const candidates = market === 'KRX'
        ? await fetchDomesticVolumeRank(appKey, appSecret, baseUrl)
        : await fetchOverseasVolumeRank(market);

      for (const candidate of candidates) {
        if (slotsAvailable <= 0) break;
        if (!candidate.ticker || holdingTickers.has(candidate.ticker) || activeTickers.has(candidate.ticker) || watchlistTickers.has(candidate.ticker)) continue;

        try {
          const candles = await fetchCandleData(candidate.ticker, market);
          if (!candles || candles.length < 30) continue;

          const indicators = analyzeTechnical(candles);

          let newsSummary: string | undefined;
          const news = await collectAndCacheNews(candidate.ticker, candidate.name, market);
          if (news.length > 0) {
            const sentiment = await summarizeNewsWithAI(news, candidate.ticker);
            newsSummary = sentiment.summary;
          }

          const input = buildAnalysisInput(candidate.ticker, candidate.name, market as any, candles, indicators, undefined, newsSummary);
          const decision = await getTradeDecision(input, 'PRE_OPEN');

          if (decision.signal === 'BUY' && decision.confidence >= 60) {
            const reason = `${decision.reasoning} [목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}]`;
            const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
            execute(
              'INSERT INTO recommendations (ticker, name, market, source, reason, signal_type, confidence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [candidate.ticker, candidate.name, market, 'ollama-auto', reason, 'BUY', decision.confidence, expiresAt]
            );
            activeTickers.add(candidate.ticker);
            slotsAvailable--;
            console.log(`[Scheduler] 신규 추천: ${candidate.ticker} ${candidate.name} (${decision.confidence}%)`);
          }
        } catch {
          // 개별 종목 오류 무시
        }
        await sleep(200);
      }
    }

    const finalCount = queryAll("SELECT id FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]).length;
    console.log(`[Scheduler] 추천종목 갱신 완료: ${market} ${finalCount}/${MAX_PER_MARKET}개`);
  }
}

/** DART 공시 실시간 감시 */
async function checkDartDisclosures() {
  const settings = getSettings();
  if (!settings.dartEnabled || !settings.dartApiKey) return;

  // 관심종목 + 보유종목의 KRX 종목만
  const stocks = queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE s.market = 'KRX' AND length(s.ticker) = 6
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `);

  for (const stock of stocks) {
    try {
      const disclosures = await getDartDisclosures(stock.ticker, 1); // 최근 1일
      for (const d of disclosures) {
        // 이미 저장된 공시인지 확인 (제목+날짜 기준)
        const existing = queryOne(
          'SELECT id FROM dart_disclosures WHERE ticker = ? AND title = ? AND report_date = ?',
          [stock.ticker, d.title, d.reportDate]
        );
        if (existing) continue;

        // 새 공시 저장
        execute(
          'INSERT INTO dart_disclosures (stock_id, ticker, title, report_date, disclosure_type, url, is_important) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [stock.id, stock.ticker, d.title, d.reportDate, d.disclosureType, d.url, d.isImportant ? 1 : 0]
        );

        // 뉴스 캐시에도 추가 (LLM 분석에 반영)
        execute(
          'INSERT INTO news_cache (ticker, title, summary, source_url, sentiment) VALUES (?, ?, ?, ?, ?)',
          [stock.ticker, `[공시] ${d.title}`, d.isImportant ? '주요공시' : '일반공시', d.url, '']
        );

        // 중요 공시면 알림
        if (d.isImportant) {
          createNotification({
            type: 'DART' as any,
            title: `공시 감지: ${stock.ticker}`,
            message: `${stock.name}: ${d.title}`,
            ticker: stock.ticker,
            market: 'KRX',
            actionUrl: d.url,
          });
          console.log(`[DART] 중요 공시: ${stock.ticker} ${stock.name} — ${d.title}`);
        }
      }
      await sleep(200); // DART API rate limit
    } catch {}
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 실시간 연속 매매 시스템 ─────────────────────────────────

/** 장 시작 전: 뉴스 수집 + 초기 분석 + 즉시 매수 */
async function runMarketOpen(market: Market) {
  addLog(market, 'PRE_OPEN', 'started', '장 시작 10분 관망 후 분석 시작');
  const settings = getSettings();

  // 글로벌 시장 컨텍스트 조회
  let marketContextStr: string | undefined;
  try {
    const ctx = await getMarketContext();
    marketContextStr = formatMarketContext(ctx, market);
    if (marketContextStr) console.log(`[Scheduler] [${market}] 시장 동향:\n  ${marketContextStr}`);
  } catch {}

  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');

  const stocks = queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name, s.market FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE (w.market IN (${ph}) OR s.market IN (${ph}))
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, [...markets, ...markets]);

  if (stocks.length === 0) {
    addLog(market, 'PRE_OPEN', 'completed', '분석 대상 종목 없음');
    return;
  }

  let buyCount = 0;
  for (const stock of stocks) {
    try {
      const news = await collectAndCacheNews(stock.ticker, stock.name, stock.market || market);
      let newsSummary: string | undefined;
      let sentimentScore: number | undefined;
      if (news.length > 0) {
        const sentiment = await summarizeNewsWithAI(news, stock.ticker);
        newsSummary = sentiment.summary;
        sentimentScore = sentiment.sentimentScore;
      }

      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      if (settings.ollamaEnabled) {
        const decision = await analyzeStock(stock, market, 'MARKET_OPEN', candles, newsSummary, sentimentScore, marketContextStr);

        // 1차 분할 매수 (30%) — 시초가 관망 후 즉시
        if (decision.signal === 'BUY' && decision.confidence >= 60 && settings.autoTradeEnabled) {
          const alreadyOrdered = queryOne(
            "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now')",
            [stock.id]
          );
          if (!alreadyOrdered) {
            try {
              // 30% 수량만 매수 (1차 분할)
              const price = await getCurrentPrice(stock.ticker, stock.market as any);
              if (price && price > 0) {
                const fullQty = calculateOrderQuantity(price, stock.market, settings.autoTradeMaxPerStock);
                const splitQty = Math.max(1, Math.floor(fullQty * 0.3));
                const result = await executeOrder({
                  stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
                  orderType: 'BUY', quantity: splitQty, price: 0, signalId: 0,
                });
                if (result.success) {
                  // split_stage=1 기록
                  execute("UPDATE auto_trades SET split_stage = 1 WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now') AND status = 'FILLED'", [stock.id]);
                  buyCount++;
                  addLog(market, 'PRE_OPEN', 'completed',
                    `1차 분할매수(30%): ${stock.ticker} ${splitQty}주 @ ${result.price?.toLocaleString()} (신뢰도 ${decision.confidence}%)`);
                  createNotification({
                    type: 'AUTO_TRADE', title: '1차 분할 매수 (30%)',
                    message: `${stock.ticker} (${stock.name}) ${splitQty}주 매수 — 2차(40%) 10분 후 추세 확인`,
                    ticker: stock.ticker, market, actionUrl: '/transactions',
                  });
                }
              }
            } catch {}
            // Rate limit은 apiQueue에서 관리
          }
        }
      }
      await sleep(100);
    } catch (err: any) {
      addLog(market, 'PRE_OPEN', 'error', `${stock.ticker} 분석 오류: ${err.message}`);
    }
  }
  addLog(market, 'PRE_OPEN', 'completed', `장 시작 분석 완료: ${stocks.length}종목 분석, ${buyCount}건 매수`);
}

/** 위험 감지 즉시 매도 판단 */
function checkEmergencySell(holding: any, currentPrice: number, stockId: number): { sell: boolean; reason: string } {
  const settings = getSettings();
  const stopLoss = -(settings.stopLossPercent || 3);

  // 1. 손절: 매입가 대비 -N% 이상 (기본 -3%)
  if (holding.unrealizedPnLPercent <= stopLoss) {
    return { sell: true, reason: `손절 (${holding.unrealizedPnLPercent.toFixed(1)}%, 기준 ${stopLoss}%)` };
  }

  // 2. 최근 신호의 stopLossPrice 이탈
  const lastSignal = queryOne(
    'SELECT indicators_json FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 1',
    [stockId]
  );
  if (lastSignal?.indicators_json) {
    try {
      const indicators = JSON.parse(lastSignal.indicators_json);
      if (indicators.stopLossPrice && currentPrice <= indicators.stopLossPrice) {
        return { sell: true, reason: `손절가 이탈 (${currentPrice} <= ${indicators.stopLossPrice})` };
      }
    } catch {}
  }

  return { sell: false, reason: '' };
}

/** 장 중 10분 간격 연속 모니터링 — 급변 감지 + 즉시 매매 */
async function runContinuousMonitor(market: Market) {
  const settings = getSettings();
  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');

  // 모니터링 대상: 관심종목 + 보유종목
  const stocks = queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name, s.market FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE s.market IN (${ph})
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, markets);

  if (stocks.length === 0) return;

  // === 분할 매수 2차/3차 체크 ===
  if (settings.autoTradeEnabled) {
    const pendingSplits = queryAll(`
      SELECT at.*, s.ticker, s.name, s.market, at.split_stage, at.price as buy_price
      FROM auto_trades at
      JOIN stocks s ON s.id = at.stock_id
      WHERE at.order_type = 'BUY' AND at.status = 'FILLED'
      AND date(at.created_at) = date('now')
      AND at.split_stage IN (1, 2)
      AND s.market IN (${ph})
    `, markets);

    for (const split of pendingSplits) {
      try {
        const currentPrice = await getCurrentPrice(split.ticker, split.market as any);
        if (!currentPrice) continue;

        // 가격이 매수가 이하면 분할 취소 (추세 이탈)
        if (currentPrice < split.buy_price * 0.98) {
          addLog(market, 'POST_OPEN', 'completed', `분할매수 취소: ${split.ticker} — 가격 하락 (${split.buy_price}→${currentPrice})`);
          continue;
        }

        const nextStage = split.split_stage + 1;
        const ratio = nextStage === 2 ? 0.4 : 0.3; // 2차 40%, 3차 30%
        const fullQty = calculateOrderQuantity(currentPrice, split.market, settings.autoTradeMaxPerStock);
        const splitQty = Math.max(1, Math.floor(fullQty * ratio));

        const result = await executeOrder({
          stockId: split.stock_id, ticker: split.ticker, market: split.market as any,
          orderType: 'BUY', quantity: splitQty, price: 0, signalId: 0,
        });

        if (result.success) {
          // 최신 auto_trade 레코드에 split_stage 기록
          execute(
            "UPDATE auto_trades SET split_stage = ? WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now') AND status = 'FILLED' ORDER BY id DESC LIMIT 1",
            [nextStage, split.stock_id]
          );
          addLog(market, 'POST_OPEN', 'completed',
            `${nextStage}차 분할매수(${Math.round(ratio * 100)}%): ${split.ticker} ${splitQty}주 @ ${currentPrice.toLocaleString()}`);
          createNotification({
            type: 'AUTO_TRADE', title: `${nextStage}차 분할 매수 (${Math.round(ratio * 100)}%)`,
            message: `${split.ticker} ${splitQty}주 추가 매수 — 추세 유지 확인`,
            ticker: split.ticker, market, actionUrl: '/transactions',
          });
        }
        // Rate limit은 apiQueue에서 관리
      } catch {}
    }
  }

  // 시세 일괄 조회
  const tickers = stocks.map((s: any) => s.ticker);
  const tickerMarkets = new Map<string, string>();
  stocks.forEach((s: any) => tickerMarkets.set(s.ticker, s.market));

  let prices: Map<string, number>;
  try {
    prices = await getMultipleStockPrices(tickers, tickerMarkets);
  } catch { return; }

  // WebSocket으로 실시간 시세 브로드캐스트
  if (prices.size > 0) {
    const broadcast = (global as any).__wsBroadcast;
    if (broadcast) {
      const priceData: Record<string, number> = {};
      prices.forEach((price, ticker) => { priceData[ticker] = price; });
      broadcast({ type: 'prices', market, data: priceData, timestamp: new Date().toISOString() });
    }
  }

  let actions = 0;
  for (const stock of stocks) {
    const currentPrice = prices.get(stock.ticker);
    if (!currentPrice) continue;

    const holding = getHoldingInfo(stock.id, currentPrice);

    // === 보유 종목: 위험 감지 → LLM 없이 즉시 매도 ===
    if (holding && holding.quantity > 0 && settings.autoTradeEnabled) {
      const emergency = checkEmergencySell(holding, currentPrice, stock.id);
      if (emergency.sell) {
        try {
          const result = await executeOrder({
            stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
            orderType: 'SELL', quantity: holding.quantity, price: 0, signalId: 0,
          });
          if (result.success) {
            actions++;
            addLog(market, 'POST_OPEN', 'completed', `긴급 매도: ${stock.ticker} ${holding.quantity}주 — ${emergency.reason}`);
            createNotification({
              type: 'AUTO_TRADE', title: '긴급 매도 실행',
              message: `${stock.ticker} (${stock.name}) ${holding.quantity}주 긴급 매도 — ${emergency.reason}`,
              ticker: stock.ticker, market, actionUrl: '/transactions',
            });
          }
        } catch {}
        // Rate limit은 apiQueue에서 관리
        continue;
      }
    }

    // === 가격 변동률 체크 (전회 대비 2% 이상이면 LLM 분석) ===
    const prevPrice = priceCache.get(stock.ticker);
    const changeRate = prevPrice ? Math.abs((currentPrice - prevPrice) / prevPrice * 100) : 999;
    priceCache.set(stock.ticker, currentPrice);

    if (changeRate < 2) continue; // 변동 적으면 스킵

    if (!settings.ollamaEnabled) continue;

    try {
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      // 분봉 단기 추세 조회 (KRX만)
      const intraday = await fetchIntradayCandles(stock.ticker, stock.market || market);

      const decision = await analyzeStock(stock, market, 'INTRADAY', candles, undefined, undefined, undefined, intraday);

      if (settings.autoTradeEnabled) {
        if (decision.signal === 'BUY' && decision.confidence >= 60) {
          const alreadyOrdered = queryOne(
            "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now')",
            [stock.id]
          );
          if (!alreadyOrdered) {
            const result = await executeOrder({
              stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
              orderType: 'BUY', quantity: 0, price: 0, signalId: 0,
            });
            if (result.success) {
              actions++;
              addLog(market, 'POST_OPEN', 'completed',
                `장중 매수: ${stock.ticker} ${result.quantity}주 (변동 ${changeRate.toFixed(1)}%, 신뢰도 ${decision.confidence}%)`);
              createNotification({
                type: 'AUTO_TRADE', title: '장중 매수',
                message: `${stock.ticker} ${result.quantity}주 매수 (가격 ${changeRate.toFixed(1)}% 변동 감지, 신뢰도 ${decision.confidence}%)`,
                ticker: stock.ticker, market, actionUrl: '/transactions',
              });
            }
            // Rate limit은 apiQueue에서 관리
          }
        } else if (decision.signal === 'SELL' && decision.confidence >= 60 && holding && holding.quantity > 0) {
          const result = await executeOrder({
            stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
            orderType: 'SELL', quantity: holding.quantity, price: 0, signalId: 0,
          });
          if (result.success) {
            actions++;
            addLog(market, 'POST_OPEN', 'completed',
              `장중 매도: ${stock.ticker} ${holding.quantity}주 (변동 ${changeRate.toFixed(1)}%, 신뢰도 ${decision.confidence}%)`);
            createNotification({
              type: 'AUTO_TRADE', title: '장중 매도',
              message: `${stock.ticker} ${holding.quantity}주 매도 (가격 ${changeRate.toFixed(1)}% 변동 감지, 신뢰도 ${decision.confidence}%)`,
              ticker: stock.ticker, market, actionUrl: '/transactions',
            });
          }
          // Rate limit은 apiQueue에서 관리
        }
      }
    } catch (err: any) {
      addLog(market, 'POST_OPEN', 'error', `${stock.ticker} 장중 분석 오류: ${err.message}`);
    }
    await sleep(100);
  }

  if (actions > 0) {
    console.log(`[Scheduler] [${market}] 장중 모니터링: ${actions}건 매매 실행`);
  }

  // 미체결 주문 관리 (국내만)
  if (market === 'KRX') {
    try { await manageUnfilledOrders(); } catch {}
  }

  // 예약 주문 체크
  try { await checkReservedOrders(prices); } catch {}
}

/** 장 마감 30분 전: 수익 종목 이익 실현 매도 */
async function runProfitTaking(market: Market) {
  addLog(market, 'PRE_CLOSE_30M', 'started', '수익 실현 매도 시작');
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    addLog(market, 'PRE_CLOSE_30M', 'completed', '자동매매 비활성화 — 스킵');
    return;
  }

  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');

  const holdingStocks = queryAll(`
    SELECT s.id, s.ticker, s.name, s.market
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.market IN (${ph})
    GROUP BY s.id
    HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, markets);

  let sellCount = 0;
  for (const stock of holdingStocks) {
    try {
      const currentPrice = await getCurrentPrice(stock.ticker, stock.market as any);
      if (!currentPrice) continue;

      const holding = getHoldingInfo(stock.id, currentPrice);
      if (!holding || holding.quantity <= 0) continue;

      const profitRate = holding.unrealizedPnLPercent;

      if (profitRate >= 10) {
        // 10% 이상 수익: 50% 부분 매도
        const sellQty = Math.floor(holding.quantity * 0.5);
        if (sellQty > 0) {
          const result = await executeOrder({
            stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
            orderType: 'SELL', quantity: sellQty, price: 0, signalId: 0,
          });
          if (result.success) {
            sellCount++;
            addLog(market, 'PRE_CLOSE_30M', 'completed',
              `수익실현 50% 매도: ${stock.ticker} ${sellQty}주 (수익률 +${profitRate.toFixed(1)}%)`);
            createNotification({
              type: 'AUTO_TRADE', title: '수익 실현 매도',
              message: `${stock.ticker} ${sellQty}주 부분 매도 (수익률 +${profitRate.toFixed(1)}%, 50% 이익 확보)`,
              ticker: stock.ticker, market, actionUrl: '/transactions',
            });
          }
          // Rate limit은 apiQueue에서 관리
        }
      } else if (profitRate >= 5 && settings.ollamaEnabled) {
        // 5~10% 수익: LLM 판단
        const candles = await fetchCandleData(stock.ticker, market);
        if (!candles || candles.length < 30) continue;

        const decision = await analyzeStock(stock, market, 'PROFIT_TAKING', candles);
        if (decision.signal === 'SELL') {
          const ratio = decision.suggestedRatio || 30;
          const sellQty = Math.floor(holding.quantity * ratio / 100);
          if (sellQty > 0) {
            const result = await executeOrder({
              stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
              orderType: 'SELL', quantity: sellQty, price: 0, signalId: 0,
            });
            if (result.success) {
              sellCount++;
              addLog(market, 'PRE_CLOSE_30M', 'completed',
                `LLM 매도: ${stock.ticker} ${sellQty}주 (수익률 +${profitRate.toFixed(1)}%, ${ratio}%)`);
            }
            // Rate limit은 apiQueue에서 관리
          }
        }
      }
    } catch (err: any) {
      addLog(market, 'PRE_CLOSE_30M', 'error', `${stock.ticker} 수익실현 오류: ${err.message}`);
    }
  }

  // 일일 리포트
  const todaySignals = queryAll(
    "SELECT signal_type, COUNT(*) as cnt FROM trade_signals WHERE date(created_at) = date('now') AND stock_id IN (SELECT id FROM stocks WHERE market IN (" + ph + ")) GROUP BY signal_type",
    markets
  );
  const todayTrades = queryAll(
    "SELECT order_type, COUNT(*) as cnt FROM auto_trades WHERE date(created_at) = date('now') AND status = 'FILLED' GROUP BY order_type",
    []
  );
  const signalSummary = todaySignals.map((s: any) => `${s.signal_type}: ${s.cnt}건`).join(', ');
  const tradeSummary = todayTrades.map((t: any) => `${t.order_type}: ${t.cnt}건`).join(', ');

  addLog(market, 'PRE_CLOSE_30M', 'completed', `일일 마감 — 신호: ${signalSummary || '없음'} / 체결: ${tradeSummary || '없음'} / 수익실현: ${sellCount}건`);
  createNotification({
    type: 'DAILY_REPORT', title: `${market} 일일 리포트`,
    message: `신호: ${signalSummary || '없음'}\n체결: ${tradeSummary || '없음'}\n수익 실현: ${sellCount}건`,
    market, actionUrl: '/portfolio',
  });
}

/** 주말 학습: 성과 평가 + 가중치 최적화 + 리포트 생성 */
async function runWeekendLearning() {
  console.log('[Scheduler] 주말 학습 시작');

  // 1. 미평가 신호 성과 평가
  try { await evaluatePendingPerformance(); } catch {}

  // 2. 가중치 최적화
  let weightChanges = '';
  try {
    const result = optimizeWeights();
    if (result.adjusted.length > 0) {
      weightChanges = result.adjusted.map((a: any) => `${a.type}: ${a.oldWeight.toFixed(2)}→${a.newWeight.toFixed(2)}`).join(', ');
    }
  } catch {}

  // 2.5 이번 주 매매 종목 백테스트
  let backtestSummary = '';
  try {
    const { runBacktest } = require('./backtester');
    const tradedTickers = queryAll(
      "SELECT DISTINCT s.ticker, s.market FROM auto_trades at JOIN stocks s ON s.id = at.stock_id WHERE at.status = 'FILLED' AND at.created_at >= datetime('now', '-7 days')"
    );
    const btResults: string[] = [];
    for (const t of tradedTickers.slice(0, 5)) { // 최대 5종목
      try {
        const candles = await fetchCandleData(t.ticker, t.market === 'KRX' ? 'KRX' : 'NYSE');
        if (candles && candles.length >= 60) {
          const result = runBacktest({ name: `auto-${t.ticker}`, ticker: t.ticker, candles, initialCapital: 2000000 });
          btResults.push(`${t.ticker}: 승률 ${(result.winRate * 100).toFixed(0)}%, 수익률 ${result.totalReturn.toFixed(1)}%`);
        }
      } catch {}
    }
    if (btResults.length > 0) backtestSummary = btResults.join(' | ');

    // A/B 전략 비교 (현재 가중치 vs 균등 가중치)
    if (tradedTickers.length > 0) {
      const { runABCompare } = require('./backtester');
      const { loadWeights } = require('./weightOptimizer');
      const currentWeights = loadWeights();
      const equalWeights: any = {};
      for (const key of Object.keys(currentWeights)) equalWeights[key] = 1.0;

      const firstTicker = tradedTickers[0];
      const candles = await fetchCandleData(firstTicker.ticker, firstTicker.market === 'KRX' ? 'KRX' : 'NYSE');
      if (candles && candles.length >= 60) {
        const abResult = runABCompare(candles, firstTicker.ticker, currentWeights, equalWeights, '최적화 전략', '기본 전략');
        backtestSummary += ` | A/B비교(${firstTicker.ticker}): ${abResult.winner === 'A' ? '최적화 승' : abResult.winner === 'B' ? '기본 승' : '무승부'}`;
        console.log(`[Scheduler] A/B 백테스트: ${abResult.summary}`);
      }
    }
  } catch {}

  // 3. 주간 통계 수집
  const weekStats: any = {
    totalSignals: queryOne("SELECT COUNT(*) as cnt FROM trade_signals WHERE created_at >= datetime('now', '-7 days')")?.cnt || 0,
    buySignals: queryOne("SELECT COUNT(*) as cnt FROM trade_signals WHERE signal_type='BUY' AND created_at >= datetime('now', '-7 days')")?.cnt || 0,
    sellSignals: queryOne("SELECT COUNT(*) as cnt FROM trade_signals WHERE signal_type='SELL' AND created_at >= datetime('now', '-7 days')")?.cnt || 0,
    tradesExecuted: queryOne("SELECT COUNT(*) as cnt FROM auto_trades WHERE status='FILLED' AND created_at >= datetime('now', '-7 days')")?.cnt || 0,
    avgConfidence: queryOne("SELECT AVG(confidence) as avg FROM trade_signals WHERE created_at >= datetime('now', '-7 days')")?.avg || 0,
    weightChanges,
    backtestSummary,
  };

  // 4. Ollama로 학습 리포트 생성
  const settings = getSettings();
  let report = `주간 요약: 신호 ${weekStats.totalSignals}건 (BUY ${weekStats.buySignals}/SELL ${weekStats.sellSignals}), 체결 ${weekStats.tradesExecuted}건, 평균신뢰도 ${Math.round(weekStats.avgConfidence)}%`;

  if (settings.ollamaEnabled) {
    try {
      const prompt = `이번 주 자동매매 트레이딩 결과를 분석하고 다음 주 전략을 제안하세요:
- 총 매매 신호: ${weekStats.totalSignals}건 (BUY ${weekStats.buySignals}건, SELL ${weekStats.sellSignals}건)
- 실제 체결: ${weekStats.tradesExecuted}건
- 평균 신뢰도: ${Math.round(weekStats.avgConfidence)}%
- 가중치 변경: ${weekStats.weightChanges || '없음'}

3~5문장으로 이번 주 성과를 평가하고, 다음 주 개선할 점 3가지를 제안하세요.`;

      const res = await fetch(`${settings.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.ollamaModel, prompt, stream: false,
          options: { temperature: 0.5, num_predict: 800 },
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        if (data.response?.trim()) report = data.response.trim();
      }
    } catch {}
  }

  // 5. DB 저장 + 알림
  execute('INSERT INTO weekly_reports (report, stats_json, weight_changes_json) VALUES (?, ?, ?)',
    [report, JSON.stringify(weekStats), weekStats.weightChanges]);

  createNotification({
    type: 'LEARNING' as any, title: '주간 학습 완료',
    message: report.slice(0, 200) + (report.length > 200 ? '...' : ''),
    actionUrl: '/feedback',
  });

  // 6. LoRA 학습 데이터 자동 체크/생성
  const loraCount = getLoraDataCount();
  if (loraCount >= 5000) {
    try {
      const loraResult = generateLoraDataset();
      console.log(`[Scheduler] ${loraResult.message}`);
      createNotification({
        type: 'LEARNING' as any,
        title: 'LoRA 학습 데이터 생성',
        message: `${loraResult.count}건의 학습 데이터가 생성되었습니다. ${loraResult.filePath}`,
        actionUrl: '/feedback',
      });
    } catch {}
  } else {
    console.log(`[Scheduler] LoRA 학습 데이터: ${loraCount}/5,000건 (${Math.round(loraCount / 5000 * 100)}%)`);
  }

  console.log('[Scheduler] 주말 학습 완료');
}

/** 관심종목 자동 정리 */
function cleanupWatchlist() {
  console.log('[Scheduler] 관심종목 자동 정리 시작');
  let removed = 0;
  let disabled = 0;

  // 규칙 1: 30일간 BUY 신호 없는 종목 삭제
  // (신호가 1개 이상 존재하지만 최근 30일 내 BUY가 없는 경우)
  const noBuyItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.added_at <= datetime('now', '-30 days')
    AND EXISTS (
      SELECT 1 FROM trade_signals ts WHERE ts.stock_id = w.stock_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM trade_signals ts
      WHERE ts.stock_id = w.stock_id
      AND ts.signal_type = 'BUY'
      AND ts.created_at >= datetime('now', '-30 days')
    )
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.stock_id = w.stock_id
      GROUP BY t.stock_id
      HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
    )
  `);

  for (const item of noBuyItems) {
    execute('DELETE FROM watchlist WHERE id = ?', [item.id]);
    createNotification({
      type: 'WATCHLIST',
      title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: 30일간 매수 신호 없음`,
      ticker: item.ticker,
      actionUrl: '/watchlist',
    });
    console.log(`[Scheduler] 관심종목 제거 (30일 BUY 없음): ${item.ticker}`);
    removed++;
  }

  // 규칙 2: 최근 3개 신호 평균 신뢰도 40% 미만 → 자동매매 비활성화
  const autoTradeItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.auto_trade_enabled = 1
  `);

  for (const item of autoTradeItems) {
    const recentSignals = queryAll(
      'SELECT confidence FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 3',
      [item.stock_id]
    );
    if (recentSignals.length >= 3) {
      const avgConfidence = recentSignals.reduce((sum: number, s: any) => sum + Number(s.confidence), 0) / recentSignals.length;
      if (avgConfidence < 40) {
        execute('UPDATE watchlist SET auto_trade_enabled = 0 WHERE id = ?', [item.id]);
        createNotification({
          type: 'WATCHLIST',
          title: '자동매매 비활성화',
          message: `${item.ticker} ${item.name}: 최근 신뢰도 낮음 (평균 ${avgConfidence.toFixed(0)}%)`,
          ticker: item.ticker,
          actionUrl: '/watchlist',
        });
        console.log(`[Scheduler] 자동매매 비활성화 (신뢰도 ${avgConfidence.toFixed(0)}%): ${item.ticker}`);
        disabled++;
      }
    }
  }

  // 규칙 3: 추천 점수 0 이하 + 14일 이상 경과 → 삭제 (보유 종목 제외)
  const lowScoreItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name, r.score
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    LEFT JOIN recommendations r ON r.ticker = s.ticker AND r.market = w.market AND r.status = 'ACTIVE'
    WHERE w.added_at <= datetime('now', '-14 days')
    AND (r.score IS NULL OR r.score <= 0)
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.stock_id = w.stock_id
      GROUP BY t.stock_id
      HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
    )
  `);

  // 규칙 1에서 이미 삭제된 ID 제외
  const removedIds = new Set(noBuyItems.map((i: any) => i.id));
  for (const item of lowScoreItems) {
    if (removedIds.has(item.id)) continue;
    execute('DELETE FROM watchlist WHERE id = ?', [item.id]);
    createNotification({
      type: 'WATCHLIST',
      title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: 추천 점수 ${item.score ?? 0}점 이하`,
      ticker: item.ticker,
      actionUrl: '/watchlist',
    });
    console.log(`[Scheduler] 관심종목 제거 (점수 ${item.score ?? 0}): ${item.ticker}`);
    removed++;
  }

  console.log(`[Scheduler] 관심종목 정리 완료: ${removed}개 제거, ${disabled}개 자동매매 비활성화`);
}
