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
import { executeOrder, getCurrentPrice, getHoldingQuantity } from './kisOrder';
import { createNotification } from './notification';
import { registerSignalForTracking, evaluatePendingPerformance } from './performanceTracker';
import { optimizeWeights } from './weightOptimizer';

type SchedulePhase = 'PRE_OPEN' | 'POST_OPEN' | 'PRE_CLOSE_1H' | 'PRE_CLOSE_30M';
type Market = 'KRX' | 'NYSE' | 'NASDAQ';

const activeTasks: cron.ScheduledTask[] = [];

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

/** 스케줄러 시작 */
export function startScheduler() {
  stopScheduler(); // 기존 스케줄 정리

  const settings = getSettings();

  // KRX 스케줄 (timezone: Asia/Seoul, 월~금)
  if (settings.scheduleKrx.enabled) {
    const krx = settings.scheduleKrx;
    if (krx.preOpen) {
      activeTasks.push(cron.schedule('30 8 * * 1-5', () => runPhase('KRX', 'PRE_OPEN'), { timezone: 'Asia/Seoul' }));
    }
    if (krx.postOpen) {
      activeTasks.push(cron.schedule('30 9 * * 1-5', () => runPhase('KRX', 'POST_OPEN'), { timezone: 'Asia/Seoul' }));
    }
    if (krx.preClose1h) {
      activeTasks.push(cron.schedule('30 14 * * 1-5', () => runPhase('KRX', 'PRE_CLOSE_1H'), { timezone: 'Asia/Seoul' }));
    }
    if (krx.preClose30m) {
      activeTasks.push(cron.schedule('0 15 * * 1-5', () => runPhase('KRX', 'PRE_CLOSE_30M'), { timezone: 'Asia/Seoul' }));
    }
    console.log('[Scheduler] KRX 스케줄 등록 완료');
  }

  // NYSE 스케줄 (timezone: America/New_York, 월~금 — 서머타임 자동)
  if (settings.scheduleNyse.enabled) {
    const nyse = settings.scheduleNyse;
    if (nyse.preOpen) {
      activeTasks.push(cron.schedule('0 9 * * 1-5', () => runPhase('NYSE', 'PRE_OPEN'), { timezone: 'America/New_York' }));
    }
    if (nyse.postOpen) {
      activeTasks.push(cron.schedule('0 10 * * 1-5', () => runPhase('NYSE', 'POST_OPEN'), { timezone: 'America/New_York' }));
    }
    if (nyse.preClose1h) {
      activeTasks.push(cron.schedule('0 15 * * 1-5', () => runPhase('NYSE', 'PRE_CLOSE_1H'), { timezone: 'America/New_York' }));
    }
    if (nyse.preClose30m) {
      activeTasks.push(cron.schedule('30 15 * * 1-5', () => runPhase('NYSE', 'PRE_CLOSE_30M'), { timezone: 'America/New_York' }));
    }
    console.log('[Scheduler] NYSE 스케줄 등록 완료');
  }

  // 추천종목 자동 갱신: 매 시간 정각 (24시간, 시장/요일 무관)
  if (settings.ollamaEnabled) {
    activeTasks.push(cron.schedule('0 * * * *', () => runRecommendationRefresh(), { timezone: 'Asia/Seoul' }));
    console.log('[Scheduler] 추천종목 자동 갱신 스케줄 등록 (매 1시간)');
  }

  // 성과 평가: 매일 18:00 KST (월~금)
  activeTasks.push(cron.schedule('0 18 * * 1-5', async () => {
    console.log('[Scheduler] 일일 성과 평가 시작');
    try {
      await evaluatePendingPerformance();
    } catch (err: any) {
      console.log(`[Scheduler] 성과 평가 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' }));
  console.log('[Scheduler] 일일 성과 평가 스케줄 등록 (18:00 KST)');

  // 가중치 최적화: 매주 일요일 06:00 KST
  activeTasks.push(cron.schedule('0 6 * * 0', () => {
    console.log('[Scheduler] 주간 가중치 최적화 시작');
    try {
      const result = optimizeWeights();
      if (result.adjusted.length > 0) {
        console.log(`[Scheduler] 가중치 조정: ${result.adjusted.length}개`);
      } else {
        console.log(`[Scheduler] 가중치 조정 없음: ${result.skipped || '변경 불필요'}`);
      }
    } catch (err: any) {
      console.log(`[Scheduler] 가중치 최적화 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' }));
  console.log('[Scheduler] 주간 가중치 최적화 스케줄 등록 (일요일 06:00 KST)');

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

/** 각 시점 실행 로직 */
async function runPhase(market: Market, phase: SchedulePhase) {
  addLog(market, phase, 'started', `${phase} 시작`);

  try {
    // 관심종목 + 보유종목 중 해당 시장 종목 가져오기
    const watchlistStocks = queryAll(
      `SELECT s.id, s.ticker, s.name, s.market, w.auto_trade_enabled
       FROM watchlist w
       JOIN stocks s ON s.id = w.stock_id
       WHERE w.market = ?`,
      [market]
    );

    const holdingStocks = queryAll(
      `SELECT DISTINCT s.id, s.ticker, s.name, s.market
       FROM stocks s
       JOIN transactions t ON t.stock_id = s.id
       WHERE s.market = ?
       GROUP BY s.id
       HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END) > 0`,
      [market]
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
async function analyzeStock(stock: any, market: Market, phase: AnalysisPhase, candles: CandleData[], newsSummary?: string) {
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

  const decision = await getTradeDecision(input, phase);

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
      if (news.length > 0) {
        newsSummary = await summarizeNewsWithAI(news, stock.ticker);
      }

      // 2. 캔들 + 기술 분석 + LLM 판단
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      if (settings.ollamaEnabled) {
        const decision = await analyzeStock(stock, market, 'PRE_OPEN', candles, newsSummary);
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

  // 자동매매 활성화된 관심종목의 오늘 BUY 신호 조회
  const buySignals = queryAll(
    `SELECT ts.*, s.ticker, s.name, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     JOIN watchlist w ON w.stock_id = s.id AND w.auto_trade_enabled = 1
     WHERE ts.signal_type = 'BUY'
     AND ts.confidence >= 60
     AND date(ts.created_at) = date('now')
     AND s.market = ?
     ORDER BY ts.confidence DESC`,
    [market]
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

    await sleep(500); // KIS API rate limit
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
        newsSummary = await summarizeNewsWithAI(cachedNews, stock.ticker);
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

  // 자동매매 활성화된 관심종목의 오늘 SELL 신호 조회
  const sellSignals = queryAll(
    `SELECT ts.*, s.ticker, s.name, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     JOIN watchlist w ON w.stock_id = s.id AND w.auto_trade_enabled = 1
     WHERE ts.signal_type = 'SELL'
     AND ts.confidence >= 60
     AND date(ts.created_at) = date('now')
     AND s.market = ?
     ORDER BY ts.confidence DESC`,
    [market]
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
            newsSummary = await summarizeNewsWithAI(news, candidate.ticker);
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
