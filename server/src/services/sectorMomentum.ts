import { getMarketHeatmap, type HeatmapData, type HeatmapSector } from './heatmapData';
import logger from '../logger';

// ── Types ──

export interface SectorMomentum {
  sector: string;
  avgChangePercent: number;
  breadthRatio: number;         // advancers / total (0~1)
  relativeStrength: number;     // vs market average (-100~+100)
  rotationSignal: 'IN' | 'OUT' | 'NEUTRAL';
  stockCount: number;
}

export interface MarketBreadth {
  advanceDeclineRatio: number;
  sectorLeadership: number;     // # of positive sectors
  totalSectors: number;
  narrowLeadership: boolean;    // <= 2 sectors driving gains
  divergenceWarning: string | null;
}

export interface SectorRotationContext {
  market: string;
  sectors: SectorMomentum[];
  breadth: MarketBreadth;
  strongSectors: string[];
  weakSectors: string[];
  updatedAt: string;
}

// ── Cache ──

const CACHE_TTL = 15 * 60 * 1000;
const ctxCache = new Map<string, { data: SectorRotationContext; fetchedAt: number }>();

// ── Core Computation ──

function computeSectorMomentum(heatmapData: HeatmapData): SectorMomentum[] {
  const sectors = heatmapData.sectors;
  if (sectors.length === 0) return [];

  // Market-wide average
  const allStocks = sectors.flatMap(s => s.stocks);
  const marketAvg = allStocks.length > 0
    ? allStocks.reduce((sum, s) => sum + s.changePercent, 0) / allStocks.length
    : 0;

  return sectors.map(sector => {
    const advancers = sector.stocks.filter(s => s.changePercent > 0).length;
    const breadthRatio = sector.stocks.length > 0 ? advancers / sector.stocks.length : 0;

    // Relative strength: how far this sector is from market average, normalized to -100~+100
    const diff = sector.avgChangePercent - marketAvg;
    const relativeStrength = Math.max(-100, Math.min(100, diff * 20));

    // Rotation signal
    let rotationSignal: 'IN' | 'OUT' | 'NEUTRAL' = 'NEUTRAL';
    if (relativeStrength > 25 && breadthRatio > 0.6) {
      rotationSignal = 'IN';
    } else if (relativeStrength < -25 && breadthRatio < 0.4) {
      rotationSignal = 'OUT';
    }

    return {
      sector: sector.sector,
      avgChangePercent: sector.avgChangePercent,
      breadthRatio: Math.round(breadthRatio * 100) / 100,
      relativeStrength: Math.round(relativeStrength),
      rotationSignal,
      stockCount: sector.stocks.length,
    };
  }).sort((a, b) => b.relativeStrength - a.relativeStrength);
}

function computeMarketBreadth(heatmapData: HeatmapData): MarketBreadth {
  const { advancers, decliners, sectors } = heatmapData;
  const total = advancers + decliners;
  const advanceDeclineRatio = decliners > 0 ? advancers / decliners : advancers > 0 ? 999 : 1;

  const positiveSectors = sectors.filter(s => s.avgChangePercent > 0).length;
  const narrowLeadership = positiveSectors <= 2 && sectors.length > 4;

  // Divergence: market up but breadth deteriorating
  const allStocks = sectors.flatMap(s => s.stocks);
  const marketAvg = allStocks.length > 0
    ? allStocks.reduce((sum, s) => sum + s.changePercent, 0) / allStocks.length
    : 0;

  let divergenceWarning: string | null = null;
  if (marketAvg > 0.5 && advanceDeclineRatio < 0.8) {
    divergenceWarning = '시장 평균 상승 중이나 하락 종목이 더 많음 — 상승 지속성 의문';
  } else if (marketAvg > 1.0 && narrowLeadership) {
    divergenceWarning = '소수 섹터만 상승 주도 — 협소 리더십 경고';
  }

  return {
    advanceDeclineRatio: Math.round(advanceDeclineRatio * 100) / 100,
    sectorLeadership: positiveSectors,
    totalSectors: sectors.length,
    narrowLeadership,
    divergenceWarning,
  };
}

// ── Public API ──

export async function getSectorRotationContext(market: 'KRX' | 'US'): Promise<SectorRotationContext> {
  const cacheKey = `rotation:${market}`;
  const cached = ctxCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  const heatmapData = await getMarketHeatmap(market);
  const sectors = computeSectorMomentum(heatmapData);
  const breadth = computeMarketBreadth(heatmapData);

  const ctx: SectorRotationContext = {
    market,
    sectors,
    breadth,
    strongSectors: sectors.filter(s => s.rotationSignal === 'IN').map(s => s.sector),
    weakSectors: sectors.filter(s => s.rotationSignal === 'OUT').map(s => s.sector),
    updatedAt: new Date().toISOString(),
  };

  ctxCache.set(cacheKey, { data: ctx, fetchedAt: Date.now() });
  return ctx;
}

/** Format sector context for LLM prompt injection */
export function formatSectorContextForLLM(ctx: SectorRotationContext): string {
  const lines: string[] = [
    `\n[섹터 로테이션 분석 — ${ctx.market}]`,
    `시장 건전성: AD비율=${ctx.breadth.advanceDeclineRatio}, 상승섹터=${ctx.breadth.sectorLeadership}/${ctx.breadth.totalSectors}`,
  ];

  if (ctx.breadth.divergenceWarning) {
    lines.push(`⚠️ 경고: ${ctx.breadth.divergenceWarning}`);
  }
  if (ctx.breadth.narrowLeadership) {
    lines.push(`⚠️ 협소 리더십: 소수 섹터만 상승 주도`);
  }

  if (ctx.strongSectors.length > 0) {
    lines.push(`강세 섹터 (IN): ${ctx.strongSectors.join(', ')}`);
  }
  if (ctx.weakSectors.length > 0) {
    lines.push(`약세 섹터 (OUT): ${ctx.weakSectors.join(', ')}`);
  }

  lines.push(`섹터 순위:`);
  for (const s of ctx.sectors.slice(0, 5)) {
    const arrow = s.rotationSignal === 'IN' ? '▲' : s.rotationSignal === 'OUT' ? '▼' : '─';
    lines.push(`  ${arrow} ${s.sector}: ${s.avgChangePercent >= 0 ? '+' : ''}${s.avgChangePercent}% (참여율 ${Math.round(s.breadthRatio * 100)}%)`);
  }

  return lines.join('\n');
}

/** Get sector data for a specific stock's sector */
export function getSectorForStock(
  ctx: SectorRotationContext,
  sector: string,
): { momentum: SectorMomentum | null; rank: number } {
  const idx = ctx.sectors.findIndex(s => s.sector === sector);
  if (idx === -1) return { momentum: null, rank: ctx.sectors.length };
  return { momentum: ctx.sectors[idx], rank: idx + 1 };
}
