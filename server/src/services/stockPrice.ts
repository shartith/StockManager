import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { kisApiCall, yahooApiCall } from './apiQueue';

/** KIS API로 단일 종목 현재가 조회 */
async function getKisStockPrice(ticker: string, token: string): Promise<number | null> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  try {
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
    });
    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
      }
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return null;
    const price = Number(data.output?.stck_prpr);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** KIS API로 해외 단일 종목 현재가 조회 */
async function getKisOverseasPrice(ticker: string, token: string, exchCode: string): Promise<number | null> {
  const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
  const trId = isVirtual ? 'VHHDFS76200200' : 'HHDFS76200200';
  try {
    const params = new URLSearchParams({
      AUTH: '', EXCD: exchCode, SYMB: ticker,
    });
    const response = await fetch(
      `${baseUrl}/uapi/overseas-price/v1/quotations/price-detail?${params}`,
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
    const price = Number(data.output?.last);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** Yahoo Finance fallback (해외주식용) */
async function getYahooStockPrice(ticker: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'StockManager/3.0' } }
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ?? null;
  } catch {
    return null;
  }
}

export async function getStockPrice(ticker: string): Promise<number | null> {
  const settings = getSettings();
  // KIS API 설정이 있으면 KIS 우선
  if (settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      const price = await getKisStockPrice(ticker, token);
      if (price !== null) return price;
    } catch {
      // KIS 실패 시 Yahoo fallback
    }
  }
  // 해외주식 또는 KIS 미설정: Yahoo Finance (ticker.KS 형식 불필요 — 실패하면 null)
  return getYahooStockPrice(ticker);
}

export async function getMultipleStockPrices(tickers: string[], tickerMarkets?: Map<string, string>): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const settings = getSettings();
  const overseasMarkets = ['NASDAQ', 'NYSE', 'AMEX', 'NASD'];

  // 국내/해외 티커 분리
  const domesticTickers: string[] = [];
  const overseasTickers: string[] = [];

  for (const ticker of tickers) {
    const market = tickerMarkets?.get(ticker) || '';
    if (overseasMarkets.includes(market)) {
      overseasTickers.push(ticker);
    } else {
      domesticTickers.push(ticker);
    }
  }

  // 국내 종목: KIS API 우선 (큐로 rate limit 관리), 실패 시 Yahoo fallback
  if (domesticTickers.length > 0 && settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      for (const ticker of domesticTickers) {
        const price = await kisApiCall(() => getKisStockPrice(ticker, token), `price-${ticker}`);
        if (price !== null) prices.set(ticker, price);
      }
    } catch {
      await Promise.allSettled(
        domesticTickers.map(async ticker => {
          const price = await yahooApiCall(() => getYahooStockPrice(ticker), `yahoo-${ticker}`);
          if (price !== null) prices.set(ticker, price);
        })
      );
    }
  } else if (domesticTickers.length > 0) {
    await Promise.allSettled(
      domesticTickers.map(async ticker => {
        const price = await yahooApiCall(() => getYahooStockPrice(ticker), `yahoo-${ticker}`);
        if (price !== null) prices.set(ticker, price);
      })
    );
  }

  // 해외 종목: KIS API 우선 (큐로 rate limit 관리), 실패 시 Yahoo fallback
  if (overseasTickers.length > 0) {
    const marketToExch: Record<string, string> = { NASDAQ: 'NAS', NYSE: 'NYS', NASD: 'NAS', AMEX: 'AMS' };

    if (settings.kisAppKey && settings.kisAppSecret) {
      try {
        const token = await getAccessToken();
        for (const ticker of overseasTickers) {
          const market = tickerMarkets?.get(ticker) || '';
          const exchCode = marketToExch[market] || 'NAS';
          const price = await kisApiCall(() => getKisOverseasPrice(ticker, token, exchCode), `overseas-${ticker}`);
          if (price !== null) prices.set(ticker, price);
        }
      } catch {}
    }

    const missingOverseas = overseasTickers.filter(t => !prices.has(t));
    if (missingOverseas.length > 0) {
      await Promise.allSettled(
        missingOverseas.map(async ticker => {
          const price = await yahooApiCall(() => getYahooStockPrice(ticker), `yahoo-${ticker}`);
          if (price !== null) prices.set(ticker, price);
        })
      );
    }
  }

  return prices;
}

// ─── 재무 데이터 (펀더멘털) ──────────────────────────────────

export interface FundamentalData {
  per?: number;
  pbr?: number;
  dividendYield?: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  // DART 재무제표
  roe?: number;
  revenue?: number;          // 매출액 (억원)
  revenueGrowth?: number;   // 매출 YoY 성장률 (%)
  operatingIncome?: number;  // 영업이익 (억원)
  operatingMargin?: number;  // 영업이익률 (%)
  netIncome?: number;        // 순이익 (억원)
  dartReportDate?: string;
}

const fundamentalCache = new Map<string, { data: FundamentalData; fetchedAt: number }>();
const FUNDAMENTAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

/** Yahoo Finance에서 재무 데이터 조회 */
export async function getFundamentals(ticker: string): Promise<FundamentalData> {
  const cached = fundamentalCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < FUNDAMENTAL_CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`
    );
    if (!res.ok) return {};
    const json: any = await res.json();
    const meta = json?.chart?.result?.[0]?.meta || {};

    const data: FundamentalData = {
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    };

    // KRX 종목: Yahoo ticker 형식이 다름 (005930.KS)
    // 기본 meta에 PER/PBR 없으면 빈 값
    fundamentalCache.set(ticker, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return {};
  }
}

/** KIS API 국내 종목 PER/PBR 조회 */
export async function getKisFundamentals(ticker: string): Promise<FundamentalData> {
  const cached = fundamentalCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < FUNDAMENTAL_CACHE_TTL) return cached.data;

  try {
    const settings = getSettings();
    if (!settings.kisAppKey || !settings.kisAppSecret) return {};

    const { appKey, appSecret, baseUrl } = getKisConfig();
    const token = await getAccessToken();

    const data: FundamentalData = await kisApiCall(async () => {
      const params = new URLSearchParams({
        fid_cond_mrkt_div_code: 'J',
        fid_input_iscd: ticker,
      });
      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: 'FHKST01010100', custtype: 'P',
          },
        }
      );
      if (!response.ok) return {};
      const json: any = await response.json();
      if (json.rt_cd !== '0') return {};
      const output = json.output || {};
      return {
        per: Number(output.per) || undefined,
        pbr: Number(output.pbr) || undefined,
        marketCap: Number(output.hts_avls) || undefined, // 시가총액(억)
      };
    }, `fundamental-${ticker}`);

    // DART 재무제표 병합 (활성화된 경우)
    try {
      if (settings.dartEnabled && settings.dartApiKey && ticker.length === 6) {
        const { getDartFinancials } = require('./dartApi');
        const dartData = await getDartFinancials(ticker);
        if (dartData) {
          if (dartData.roe) data.roe = dartData.roe;
          if (dartData.revenue) data.revenue = dartData.revenue;
          if (dartData.revenueGrowth !== undefined) data.revenueGrowth = dartData.revenueGrowth;
          if (dartData.operatingIncome) data.operatingIncome = dartData.operatingIncome;
          if (dartData.operatingMargin) data.operatingMargin = dartData.operatingMargin;
          if (dartData.netIncome) data.netIncome = dartData.netIncome;
          if (dartData.reportDate) data.dartReportDate = dartData.reportDate;
        }
      }
    } catch {}

    fundamentalCache.set(ticker, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return {};
  }
}

// ─── 글로벌 시장 컨텍스트 ─────────────────────────────────

export interface MarketContextData {
  kospi?: { price: number; changePercent: number };
  kosdaq?: { price: number; changePercent: number };
  sp500?: { price: number; changePercent: number };
  dow?: { price: number; changePercent: number };
  vix?: { price: number; changePercent: number };
  usdKrw?: { price: number; changePercent: number };
}

let marketContextCache: { data: MarketContextData; fetchedAt: number } | null = null;
const CONTEXT_CACHE_TTL = 30 * 60 * 1000; // 30분

async function fetchYahooQuote(symbol: string): Promise<{ price: number; changePercent: number } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'StockManager/3.0' } }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    // range=1d일 때 chartPreviousClose = 전일 종가 (정확)
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const changePercent = prevClose ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : 0;
    return { price, changePercent };
  } catch {
    return null;
  }
}

/** 글로벌 시장 지수 조회 (KOSPI, S&P500, VIX, 환율 등) */
export async function getMarketContext(): Promise<MarketContextData> {
  const now = Date.now();
  if (marketContextCache && now - marketContextCache.fetchedAt < CONTEXT_CACHE_TTL) {
    return marketContextCache.data;
  }

  const symbols = [
    { key: 'kospi', symbol: '^KS11' },
    { key: 'kosdaq', symbol: '^KQ11' },
    { key: 'sp500', symbol: '^GSPC' },
    { key: 'dow', symbol: '^DJI' },
    { key: 'vix', symbol: '^VIX' },
    { key: 'usdKrw', symbol: 'KRW=X' },
  ];

  const results = await Promise.allSettled(
    symbols.map(async s => ({ key: s.key, data: await fetchYahooQuote(s.symbol) }))
  );

  const context: MarketContextData = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.data) {
      (context as any)[r.value.key] = r.value.data;
    }
  }

  marketContextCache = { data: context, fetchedAt: now };
  return context;
}

/** 시장 컨텍스트를 LLM 입력용 텍스트로 변환 */
export function formatMarketContext(ctx: MarketContextData, market: string): string {
  const lines: string[] = [];

  if (market === 'KRX') {
    if (ctx.kospi) lines.push(`KOSPI: ${ctx.kospi.price.toLocaleString()} (${ctx.kospi.changePercent >= 0 ? '+' : ''}${ctx.kospi.changePercent}%)`);
    if (ctx.kosdaq) lines.push(`KOSDAQ: ${ctx.kosdaq.price.toLocaleString()} (${ctx.kosdaq.changePercent >= 0 ? '+' : ''}${ctx.kosdaq.changePercent}%)`);
    if (ctx.usdKrw) lines.push(`USD/KRW: ${ctx.usdKrw.price.toLocaleString()} (${ctx.usdKrw.changePercent >= 0 ? '+' : ''}${ctx.usdKrw.changePercent}%)`);
    // 전날 미국 시장도 포함
    if (ctx.sp500) lines.push(`S&P500(전일): ${ctx.sp500.price.toLocaleString()} (${ctx.sp500.changePercent >= 0 ? '+' : ''}${ctx.sp500.changePercent}%)`);
  } else {
    if (ctx.sp500) lines.push(`S&P500: ${ctx.sp500.price.toLocaleString()} (${ctx.sp500.changePercent >= 0 ? '+' : ''}${ctx.sp500.changePercent}%)`);
    if (ctx.dow) lines.push(`다우: ${ctx.dow.price.toLocaleString()} (${ctx.dow.changePercent >= 0 ? '+' : ''}${ctx.dow.changePercent}%)`);
    if (ctx.vix) lines.push(`VIX: ${ctx.vix.price.toFixed(1)} (${ctx.vix.changePercent >= 0 ? '+' : ''}${ctx.vix.changePercent}%)`);
    if (ctx.usdKrw) lines.push(`USD/KRW: ${ctx.usdKrw.price.toLocaleString()}`);
  }

  // VIX 경고
  if (ctx.vix) {
    if (ctx.vix.price > 30) lines.push('⚠️ VIX 30 초과 — 극도의 공포, 신규 매수 매우 보수적으로');
    else if (ctx.vix.price > 25) lines.push('⚠️ VIX 25 초과 — 공포 구간, 신규 매수 보수적으로');
  }

  // 환율 전략 경고
  if (ctx.usdKrw) {
    const rate = ctx.usdKrw.price;
    const change = Math.abs(ctx.usdKrw.changePercent);
    if (change >= 1) {
      lines.push(`⚠️ 환율 일 변동 ${ctx.usdKrw.changePercent > 0 ? '+' : ''}${ctx.usdKrw.changePercent}% — 양 시장 변동성 확대 주의`);
    }
    if (market === 'KRX') {
      if (rate >= 1380) lines.push('📉 원화 약세 구간 — KRX 외국인 매도 압력, 수출주 유리');
      else if (rate <= 1320) lines.push('📈 원화 강세 구간 — KRX 외국인 매수 유입, 내수주 유리');
    } else {
      if (rate >= 1380) lines.push('💵 달러 강세 — NYSE 매수 적극적 (달러 자산 가치 ↑)');
      else if (rate <= 1320) lines.push('💴 달러 약세 — NYSE 매수 보수적 (환차손 리스크)');
    }
  }

  return lines.join('\n  ');
}
