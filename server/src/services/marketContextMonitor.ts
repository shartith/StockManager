/**
 * 분당 시장 컨텍스트 모니터 — KOSPI/VIX 인트라데이 변화 추적.
 *
 * marketBrake 가 매수 진입의 binary on/off 라면, 이 모듈은 보유분 보호용
 * 동적 컨텍스트 평가:
 *
 *   NORMAL    — 평이
 *   DEFENSIVE — KOSPI 세션 고점 대비 -1% 이상 하락 OR VIX 세션 저점 대비 +20% 이상 상승
 *   CRITICAL  — KOSPI 세션 고점 대비 -2% 이상 OR VIX > 30
 *
 * sellRules 가 ctx.contextLevel 을 받아 BEARISH_PATTERN/조기청산 룰 강도 조절.
 */

import { fetchYahooQuote } from './stockPrice';
import logger from '../logger';

export type ContextLevel = 'NORMAL' | 'DEFENSIVE' | 'CRITICAL';

interface Snapshot {
  ts: number;
  kospi: number | null;
  kospiChange: number | null;
  vix: number | null;
}

let _today = '';
let _snapshots: Snapshot[] = [];
let _sessionKospiHigh = -Infinity;
let _sessionVixLow = Infinity;

function todayKstDate(): string {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).toISOString().slice(0, 10);
}

function rollIfNewDay(): void {
  const today = todayKstDate();
  if (_today !== today) {
    _today = today;
    _snapshots = [];
    _sessionKospiHigh = -Infinity;
    _sessionVixLow = Infinity;
  }
}

/** 1분 cron 에서 호출 — KOSPI / VIX 현재 값을 push. */
export async function recordContextSnapshot(): Promise<void> {
  rollIfNewDay();
  try {
    const [kospi, vix] = await Promise.all([
      fetchYahooQuote('^KS11').catch(() => null),
      fetchYahooQuote('^VIX').catch(() => null),
    ]);
    const snap: Snapshot = {
      ts: Date.now(),
      kospi: kospi?.price ?? null,
      kospiChange: kospi?.changePercent ?? null,
      vix: vix?.price ?? null,
    };
    if (snap.kospi !== null && snap.kospi > _sessionKospiHigh) _sessionKospiHigh = snap.kospi;
    if (snap.vix !== null && snap.vix < _sessionVixLow) _sessionVixLow = snap.vix;
    _snapshots.push(snap);
    // 메모리 cap (1분×6.5h = 390 → 500 cap)
    if (_snapshots.length > 500) _snapshots.shift();
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'recordContextSnapshot failed');
  }
}

/** 현재 세션 고점/저점 대비 변동 평가. */
export function getContextLevel(): {
  level: ContextLevel;
  kospiDropFromHigh: number | null;
  vixSpikeFromLow: number | null;
  reason: string;
} {
  rollIfNewDay();
  if (_snapshots.length === 0) {
    return { level: 'NORMAL', kospiDropFromHigh: null, vixSpikeFromLow: null, reason: '데이터 없음' };
  }
  const last = _snapshots[_snapshots.length - 1];

  let kospiDrop: number | null = null;
  if (last.kospi !== null && _sessionKospiHigh > -Infinity && _sessionKospiHigh > 0) {
    kospiDrop = ((last.kospi - _sessionKospiHigh) / _sessionKospiHigh) * 100;
  }
  let vixSpike: number | null = null;
  if (last.vix !== null && _sessionVixLow < Infinity && _sessionVixLow > 0) {
    vixSpike = ((last.vix - _sessionVixLow) / _sessionVixLow) * 100;
  }

  let level: ContextLevel = 'NORMAL';
  const reasons: string[] = [];

  if ((kospiDrop !== null && kospiDrop <= -2.0) || (last.vix !== null && last.vix > 30)) {
    level = 'CRITICAL';
    if (kospiDrop !== null && kospiDrop <= -2.0) reasons.push(`KOSPI 세션고점 대비 ${kospiDrop.toFixed(2)}%`);
    if (last.vix !== null && last.vix > 30) reasons.push(`VIX ${last.vix.toFixed(1)} > 30`);
  } else if ((kospiDrop !== null && kospiDrop <= -1.0) || (vixSpike !== null && vixSpike >= 20)) {
    level = 'DEFENSIVE';
    if (kospiDrop !== null && kospiDrop <= -1.0) reasons.push(`KOSPI 세션고점 대비 ${kospiDrop.toFixed(2)}%`);
    if (vixSpike !== null && vixSpike >= 20) reasons.push(`VIX 세션저점 대비 +${vixSpike.toFixed(1)}%`);
  }

  return {
    level,
    kospiDropFromHigh: kospiDrop,
    vixSpikeFromLow: vixSpike,
    reason: reasons.join(' / '),
  };
}

/** 디버그/UI 노출용 — 최근 N 분의 스냅샷 히스토리. */
export function getRecentSnapshots(limit: number = 60): Snapshot[] {
  rollIfNewDay();
  return _snapshots.slice(-limit);
}
