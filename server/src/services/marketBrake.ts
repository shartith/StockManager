/**
 * Market Brake — 시장 전체 폭락/공포 시 신규 매수 일괄 차단 (HIGH #1).
 *
 * KOSPI 등락률이 settings.marketBrakeKospiPercent 이하면 신규 매수 차단.
 * 매도/예약/EOD는 영향 받지 않음. dailyStrategy.runMonitorTick에서 매수 평가 직전 호출.
 */

import { fetchYahooQuote } from './stockPrice';
import { getSettings } from './settings';
import logger from '../logger';

interface BrakeCache {
  shouldBrake: boolean;
  reason: string;
  fetchedAt: number;
}

let cache: BrakeCache | null = null;
const CACHE_TTL_MS = 60_000; // 1분 캐시 (5분 cron보다 짧게)

export interface BrakeStatus {
  shouldBrake: boolean;
  reason: string;
  kospiPercent?: number;
  vixLevel?: number;
}

/**
 * 시장 brake 상태 조회. 매수 차단이 필요한지 결정.
 */
export async function checkMarketBrake(): Promise<BrakeStatus> {
  const settings = getSettings();
  if (!settings.marketBrakeEnabled) {
    return { shouldBrake: false, reason: '' };
  }

  // Cache hit
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { shouldBrake: cache.shouldBrake, reason: cache.reason };
  }

  const threshold = -Math.abs(settings.marketBrakeKospiPercent); // -2.0 등
  const vixThreshold = settings.marketBrakeVixLevel ?? 30;

  let shouldBrake = false;
  const reasons: string[] = [];
  let kospiPct: number | undefined;
  let vixLvl: number | undefined;

  try {
    const kospi = await fetchYahooQuote('^KS11');
    if (kospi) {
      kospiPct = kospi.changePercent;
      if (kospi.changePercent <= threshold) {
        shouldBrake = true;
        reasons.push(`KOSPI ${kospi.changePercent.toFixed(2)}% ≤ ${threshold}%`);
      }
    }
  } catch {}

  try {
    const vix = await fetchYahooQuote('^VIX');
    if (vix) {
      vixLvl = vix.price;
      if (vix.price >= vixThreshold) {
        shouldBrake = true;
        reasons.push(`VIX ${vix.price.toFixed(1)} ≥ ${vixThreshold}`);
      }
    }
  } catch {}

  const reason = reasons.join(' / ');
  cache = { shouldBrake, reason, fetchedAt: Date.now() };

  if (shouldBrake) {
    logger.warn({ reason, kospiPct, vixLvl }, '🚨 Market brake activated — 신규 매수 차단');
  }

  return { shouldBrake, reason, kospiPercent: kospiPct, vixLevel: vixLvl };
}

/** 테스트/수동: 캐시 무효화 */
export function invalidateBrakeCache(): void {
  cache = null;
}
