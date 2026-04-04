/**
 * 스케줄러 공유 유틸리티 함수
 */

import { queryAll, queryOne, execute } from '../../db';
import { analyzeTechnical, calcRSI, CandleData } from '../technicalAnalysis';
import { getTradeDecision, buildAnalysisInput, AnalysisPhase } from '../ollama';
import { getAccessToken, getKisConfig } from '../kisAuth';
import { registerSignalForTracking } from '../performanceTracker';
import { getPortfolioRiskContext } from '../calculator';
import { getKisFundamentals } from '../stockPrice';
import { getInvestorFlow } from '../investorFlow';
import { logSystemEvent } from '../systemEvent';
import { createReservedOrder } from '../orderManager';
import logger from '../../logger';
import { Market } from './types';

/** 시장별 관련 마켓 코드 목록 (NYSE → NASDAQ/AMEX 포함) */
export function getMarketList(market: Market): string[] {
  return market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
}

/** 모니터링 대상 종목 조회 (관심종목 + 보유종목) */
export function getMonitorTargets(market: Market): any[] {
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

/** 종목의 보유 현황 조회 */
export function getHoldingInfo(stockId: number, currentPrice: number) {
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

/** KIS API로 캔들 데이터 조회 (국내/해외 분기) */
export async function fetchCandleData(ticker: string, market: Market): Promise<CandleData[] | null> {
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
export async function fetchDomesticCandles(
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
export async function fetchOverseasCandles(
  ticker: string, market: Market, token: string, appKey: string, appSecret: string,
  baseUrl: string, start: string, end: string, isVirtual: boolean,
): Promise<CandleData[] | null> {
  const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
  const trId = isVirtual ? 'VHHDFS76240000' : 'HHDFS76240000';

  const params = new URLSearchParams({
    AUTH: '',
    EXCD: exchCode,
    SYMB: ticker,
    GUBN: '0',
    BYMD: end,
    MODP: '1',
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
export async function fetchIntradayCandles(ticker: string, market: string): Promise<{ trend: 'UP' | 'DOWN' | 'FLAT'; shortRsi: number | null; data: CandleData[] }> {
  const defaultResult = { trend: 'FLAT' as const, shortRsi: null, data: [] };
  if (market !== 'KRX') return defaultResult;

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
      fid_etc_cls_code: '5',
    });

    const trId = 'FHKST03010200'; // 국내 분봉은 가상/실전 동일 tr_id
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

    const recent5 = candles.slice(0, 5).reduce((s, c) => s + c.close, 0) / 5;
    const prev5 = candles.slice(5, 10).reduce((s, c) => s + c.close, 0) / 5;
    const trendRatio = (recent5 - prev5) / prev5 * 100;
    const trend = trendRatio > 0.3 ? 'UP' : trendRatio < -0.3 ? 'DOWN' : 'FLAT';

    const closes = candles.map(c => c.close).reverse();
    const shortRsi = closes.length >= 15 ? calcRSI(closes, 14) : null;

    return { trend, shortRsi, data: candles };
  } catch {
    return defaultResult;
  }
}

/** 공통: 종목 분석 + LLM 판단 */
export async function analyzeStock(stock: any, market: Market, phase: AnalysisPhase, candles: CandleData[], newsSummary?: string, sentimentScore?: number, marketContextStr?: string, intradayData?: { trend: 'UP' | 'DOWN' | 'FLAT'; shortRsi: number | null }) {
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

  if (sentimentScore !== undefined) input.sentimentScore = sentimentScore;
  if (marketContextStr) input.marketContext = marketContextStr;
  if (intradayData) input.intradayTrend = intradayData;

  if (candles.length >= 2) {
    const prevClose = candles[candles.length - 2].close;
    const todayOpen = candles[candles.length - 1].open;
    const gapPercent = Math.round(((todayOpen - prevClose) / prevClose) * 10000) / 100;
    input.gapAnalysis = {
      prevClose, todayOpen, gapPercent,
      gapType: gapPercent >= 1 ? 'GAP_UP' : gapPercent <= -1 ? 'GAP_DOWN' : 'FLAT',
    };
  }

  try {
    const fundamentals = await getKisFundamentals(stock.ticker);
    if (fundamentals && (fundamentals.per || fundamentals.pbr)) input.fundamentals = fundamentals;
  } catch {}
  try {
    const flow = await getInvestorFlow(stock.ticker, stock.market || market);
    if (flow) input.investorFlow = flow;
  } catch {}

  try {
    input.portfolioContext = getPortfolioRiskContext();
  } catch {}

  let decision;
  try {
    decision = await getTradeDecision(input, phase);
  } catch (llmErr: any) {
    await logSystemEvent('WARN', 'OLLAMA_DOWN',
      `LLM 연결 실패 — 기술적 분석 fallback: ${stock.ticker}`,
      llmErr.message, stock.ticker);

    const techSignal = input.indicators.technicalSignal;
    decision = {
      signal: techSignal,
      confidence: techSignal === 'HOLD' ? 30 : 50,
      targetPrice: null, stopLossPrice: null, entryPrice: null,
      suggestedRatio: 30, urgency: 'NO_RUSH' as const,
      reasoning: `[LLM 미연결 fallback] 기술적 분석 기반: ${input.indicators.technicalReasons.join(', ')}`,
      keyFactors: input.indicators.technicalReasons,
      risks: ['LLM 미연결로 인한 제한적 분석'],
      holdingPeriod: 'SHORT_TERM' as const,
    };
  }

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

  if (signalId > 0) {
    registerSignalForTracking(signalId);
  }

  if (decision.signal === 'BUY' && decision.urgency === 'WAIT_DIP' && decision.entryPrice) {
    createReservedOrder(
      stock.id, stock.ticker, stock.market || market,
      'BUY', decision.entryPrice, 'BELOW', 0,
      `LLM WAIT_DIP: ${decision.reasoning?.slice(0, 100)}`
    );
  }

  return decision;
}

/** sleep 유틸리티 */
export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
