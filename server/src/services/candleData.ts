/**
 * KRX 일봉 캔들 데이터 fetcher (KIS Open API).
 *
 * 기존 routes/analysis.ts 안에 있던 fetchAnalysisCandles 를 서비스로 추출 —
 * entryExitPlan, candlePatterns 등이 공통 사용.
 */

import { getKisConfig, getAccessToken } from './kisAuth';
import type { CandleData } from './technicalAnalysis';
import logger from '../logger';

interface FetchOptions {
  /** 가져올 일수 (기본 120) */
  days?: number;
  /** 시장 (현재 KRX 만 지원) */
  market?: string;
}

const _cache = new Map<string, { fetchedAt: number; candles: CandleData[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

export async function fetchDailyCandles(
  ticker: string,
  opts: FetchOptions = {},
): Promise<CandleData[]> {
  const days = opts.days ?? 120;
  const cacheKey = `${ticker}|${days}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.candles;
  }

  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret) return [];

  try {
    const token = await getAccessToken();
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - days * 1.6); // 영업일/주말 여유
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');

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
      },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { rt_cd?: string; output2?: unknown[] };
    if (data.rt_cd !== '0') return [];

    const rows = (data.output2 || []) as Array<Record<string, string | number>>;
    const candles: CandleData[] = rows
      .filter(item => item.stck_bsop_date && Number(item.stck_oprc) > 0)
      .map(item => ({
        time: `${String(item.stck_bsop_date).slice(0, 4)}-${String(item.stck_bsop_date).slice(4, 6)}-${String(item.stck_bsop_date).slice(6, 8)}`,
        open: Number(item.stck_oprc),
        high: Number(item.stck_hgpr),
        low: Number(item.stck_lwpr),
        close: Number(item.stck_clpr),
        volume: Number(item.acml_vol),
      }))
      .sort((a, b) => (a.time > b.time ? 1 : -1));

    _cache.set(cacheKey, { fetchedAt: Date.now(), candles });
    return candles;
  } catch (err) {
    logger.warn({ err: (err as Error).message, ticker }, 'fetchDailyCandles failed');
    return [];
  }
}

export function invalidateCandleCache(ticker?: string): void {
  if (!ticker) {
    _cache.clear();
    return;
  }
  for (const key of _cache.keys()) {
    if (key.startsWith(`${ticker}|`)) _cache.delete(key);
  }
}
