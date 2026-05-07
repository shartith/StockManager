/**
 * Pre-Market Strategy — 미국 마감 → KRX 섹터 신호 → 전략 후보 생성.
 *
 * 호출 시점: 08:50 buildAutoList 내부 첫 단계 (KRX 섹터 로테이션 직전).
 * 결과는 strategic 카테고리로 watch_targets 에 들어가며,
 * 매수 평가 시점에 다른 카테고리(rotation, breakout)와 동일하게 처리.
 *
 * 흐름:
 *   1. US 섹터 ETF 변동률 fetch (Yahoo, parallel)
 *   2. Hot ETF (>= 1.5%) → 1차 KRX 섹터 매핑
 *   3. 체인링크 expansion (1차 → 2차 → 3차)
 *   4. 가중치 정렬 후 KRX_TOP_STOCKS 풀에서 섹터당 N개 선정
 */

import { fetchYahooQuote } from './stockPrice';
import { KRX_TOP_STOCKS } from '../config/marketStocks';
import {
  US_ETF_SIGNALS,
  US_HOT_THRESHOLD_PERCENT,
  US_WEIGHT_NORMALIZER,
  US_WEIGHT_CAP,
} from '../config/usSectorMap';
import { KRX_CHAIN_LINKS, CHAIN_WEIGHTS } from '../config/krxChainLinks';
import logger from '../logger';

export interface StrategicCandidate {
  ticker: string;
  yahooTicker: string;
  name: string;
  sector: string;
  weight: number;
  reason: string;
}

export interface HotEtfQuote {
  ticker: string;
  name: string;
  changePercent: number;
}

export interface SectorWeight {
  sector: string;
  weight: number;
  /** 가중치 산출 근거 (가장 강한 시그널 한 줄) */
  topSource: string;
  /** 1차 / 2차 / 3차 분류 */
  tier: 'primary' | 'secondary' | 'tertiary';
}

export interface PreMarketAnalysis {
  hotEtfs: HotEtfQuote[];
  sectorWeights: SectorWeight[];
  candidates: StrategicCandidate[];
  fetchedAt: string;
}

const PER_SECTOR_LIMIT = 3;

/**
 * 단일 ETF 변동률 → 가중치 변환.
 * 임계값(1.5%)에서 weight=1.0, +3% 에서 weight=2.0 (cap).
 */
function etfWeight(changePercent: number): number {
  return Math.min(changePercent / US_WEIGHT_NORMALIZER, US_WEIGHT_CAP);
}

export async function runPreMarketStrategy(): Promise<PreMarketAnalysis> {
  const fetchedAt = new Date().toISOString();

  // 1. US ETF 병렬 fetch
  const fetched = await Promise.allSettled(
    US_ETF_SIGNALS.map(async (etf) => {
      const quote = await fetchYahooQuote(etf.yahooTicker);
      return { etf, quote };
    }),
  );

  const hotEtfs: HotEtfQuote[] = [];
  // sector → { weight, topSource, tier }
  const sectorMap = new Map<string, SectorWeight>();

  // 2. 1차 매핑
  for (const r of fetched) {
    if (r.status !== 'fulfilled') continue;
    const { etf, quote } = r.value;
    if (!quote) continue;

    const ch = quote.changePercent;
    if (ch < US_HOT_THRESHOLD_PERCENT) continue;

    hotEtfs.push({ ticker: etf.yahooTicker, name: etf.name, changePercent: ch });
    const baseW = etfWeight(ch) * CHAIN_WEIGHTS.primary;
    const sourceLabel = `${etf.yahooTicker} +${ch.toFixed(2)}%`;

    for (const sec of etf.krxSectors) {
      const cur = sectorMap.get(sec);
      if (!cur || baseW > cur.weight) {
        sectorMap.set(sec, {
          sector: sec,
          weight: baseW,
          topSource: sourceLabel,
          tier: 'primary',
        });
      }
    }
  }

  // 3. 체인링크 expansion (snapshot 으로 순회 — 확장이 또 확장을 트리거하지 않음)
  const primarySectors = [...sectorMap.values()].filter(s => s.tier === 'primary');
  for (const primary of primarySectors) {
    const link = KRX_CHAIN_LINKS[primary.sector];
    if (!link) continue;

    for (const sec2 of link.secondary) {
      const w = primary.weight * CHAIN_WEIGHTS.secondary / CHAIN_WEIGHTS.primary;
      const cur = sectorMap.get(sec2);
      if (!cur || w > cur.weight) {
        sectorMap.set(sec2, {
          sector: sec2,
          weight: w,
          topSource: `${primary.sector} 2차링크 (${primary.topSource})`,
          tier: cur?.tier === 'primary' ? 'primary' : 'secondary',
        });
      }
    }
    for (const sec3 of link.tertiary) {
      const w = primary.weight * CHAIN_WEIGHTS.tertiary / CHAIN_WEIGHTS.primary;
      const cur = sectorMap.get(sec3);
      if (!cur || w > cur.weight) {
        sectorMap.set(sec3, {
          sector: sec3,
          weight: w,
          topSource: `${primary.sector} 3차링크 (${primary.topSource})`,
          tier: cur?.tier === 'primary' || cur?.tier === 'secondary' ? cur.tier : 'tertiary',
        });
      }
    }
  }

  const sectorWeights = [...sectorMap.values()].sort((a, b) => b.weight - a.weight);

  // 4. KRX_TOP_STOCKS 에서 섹터별 후보 추출 (08:30 시점엔 KRX 시세 없음 → 정적 풀 순서)
  const candidates: StrategicCandidate[] = [];
  const seen = new Set<string>();
  for (const sw of sectorWeights) {
    const pool = KRX_TOP_STOCKS.filter(s => s.sector === sw.sector);
    let added = 0;
    for (const stock of pool) {
      if (added >= PER_SECTOR_LIMIT) break;
      if (seen.has(stock.ticker)) continue;
      seen.add(stock.ticker);
      candidates.push({
        ticker: stock.ticker,
        yahooTicker: stock.yahooTicker,
        name: stock.name,
        sector: stock.sector,
        weight: sw.weight,
        reason: `[전략/${sw.tier}] ${sw.topSource} → ${sw.sector} (w=${sw.weight.toFixed(2)})`,
      });
      added++;
    }
  }

  logger.info(
    {
      hotEtfCount: hotEtfs.length,
      sectorCount: sectorWeights.length,
      candidateCount: candidates.length,
      topSectors: sectorWeights.slice(0, 3).map(s => `${s.sector}:${s.weight.toFixed(2)}`),
    },
    '[PreMarketStrategy] 분석 완료',
  );

  return { hotEtfs, sectorWeights, candidates, fetchedAt };
}

// 마지막 분석 캐시 (UI/디버그 목적)
let _lastAnalysis: PreMarketAnalysis | null = null;

export function getLastPreMarketAnalysis(): PreMarketAnalysis | null {
  return _lastAnalysis;
}

export function setLastPreMarketAnalysis(a: PreMarketAnalysis): void {
  _lastAnalysis = a;
}
