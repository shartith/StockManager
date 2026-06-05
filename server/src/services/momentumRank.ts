/**
 * Momentum ranking (v6.0).
 *
 * 시총 순위 대신 "가격 모멘텀"(trailing N일 수익률)으로 종목을 선정.
 * 멀티 레짐 백테스트(8개 연도)에서 시총 선택 대비 복리수익 2배(6.7%→14.7%/년) 입증.
 *
 * 설계:
 *   - 유니버스: 시총 Top 30 (topMarketCap) — 유동성/대형주 필터
 *   - 점수: trailing 120거래일 수익률 (백테스트와 동일; 단순 모멘텀, skip-month 미적용)
 *   - 데이터: Yahoo 일봉(.KS → .KQ 폴백). 일 단위 캐시.
 *   - 폴백: 모멘텀 조회 실패 종목은 유니버스에서 제외. 전부 실패하면 호출부가 시총 폴백.
 *
 * 주의: 모멘텀은 "모멘텀 크래시"(급반등장에서 약세주가 더 튐) 리스크가 있음 — 레짐 필터와 병용 권장.
 */

import logger from '../logger';
import type { TopStock } from './topMarketCap';

const MOMENTUM_LOOKBACK_DAYS = 120;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간 (매시간 rebalance 와 정합)
const FETCH_TIMEOUT_MS = 8_000;

interface MomentumScore {
  ticker: string;
  score: number;      // trailing 수익률 (0.25 = +25%)
  firstClose: number;
  lastClose: number;
}

let cache: { scores: Map<string, number>; fetchedAt: number } | null = null;

/** Yahoo 일봉 종가 배열 조회 (최신이 마지막). 실패 시 빈 배열. */
async function fetchCloses(ticker: string): Promise<number[]> {
  const suffixes = ['KS', 'KQ'];
  for (const sfx of suffixes) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.${sfx}?interval=1d&range=8mo`,
        { headers: { 'User-Agent': 'StockManager/6.0' }, signal: controller.signal },
      ).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      const data = (await res.json()) as {
        chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
      };
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (!Array.isArray(closes)) continue;
      const clean = closes.filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
      if (clean.length >= 40) return clean; // 최소 데이터 확보된 시장만 채택
    } catch {
      // 다음 suffix 시도
    }
  }
  return [];
}

/** 단일 종목 모멘텀 점수 — trailing LOOKBACK 수익률. 데이터 부족 시 null. */
function computeScore(ticker: string, closes: number[]): MomentumScore | null {
  if (closes.length < 40) return null;
  const lastClose = closes[closes.length - 1];
  // LOOKBACK 거래일 전 종가 (부족하면 가장 오래된 값으로 — 짧은 상장 종목 보정)
  const lookbackIdx = Math.max(0, closes.length - 1 - MOMENTUM_LOOKBACK_DAYS);
  const firstClose = closes[lookbackIdx];
  if (firstClose <= 0) return null;
  return { ticker, score: (lastClose - firstClose) / firstClose, firstClose, lastClose };
}

/**
 * 유니버스(시총 Top 30 등) 의 모멘텀 점수 맵을 반환. 일 단위 캐시.
 * 빈 맵이면 호출부가 시총 폴백.
 */
export async function fetchMomentumScores(universe: TopStock[]): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.scores;

  const scores = new Map<string, number>();
  // 동시 요청은 부담되니 소규모 병렬 (5개씩)
  const BATCH = 5;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (s) => ({ ticker: s.ticker, closes: await fetchCloses(s.ticker) })),
    );
    for (const { ticker, closes } of results) {
      const sc = computeScore(ticker, closes);
      if (sc) scores.set(ticker, sc.score);
    }
  }

  if (scores.size > 0) {
    cache = { scores, fetchedAt: Date.now() };
    logger.info({ scored: scores.size, universe: universe.length }, '[Momentum] scores fetched');
  } else {
    logger.warn('[Momentum] 모멘텀 점수 전부 실패 — 호출부 시총 폴백 예상');
  }
  return scores;
}

/**
 * 유니버스를 모멘텀 점수 내림차순으로 재정렬하고 rank 를 1..N 으로 재부여.
 * 점수가 없는 종목은 맨 뒤로(랭크는 부여하되 사실상 매수 대상에서 밀림).
 * 점수 맵이 비면 입력 그대로(시총 순서) 반환 — 폴백.
 */
export function rankByMomentum(universe: TopStock[], scores: Map<string, number>): TopStock[] {
  if (scores.size === 0) return universe;
  const sorted = [...universe].sort((a, b) => {
    const sa = scores.has(a.ticker) ? scores.get(a.ticker)! : -Infinity;
    const sb = scores.has(b.ticker) ? scores.get(b.ticker)! : -Infinity;
    return sb - sa;
  });
  return sorted.map((s, i) => ({ ...s, rank: i + 1 }));
}

/** 테스트/수동: 캐시 무효화 */
export function invalidateMomentumCache(): void {
  cache = null;
}
