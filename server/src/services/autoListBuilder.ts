/**
 * Auto List Builder — Rule 1, 2 (감시대상 자동목록).
 *
 * v5.1.0 추가:
 *   - 갭상승 ≥ gapUpMaxPercent 종목 자동 제외 (HIGH #3)
 *   - 거래량 0 종목 제외 (구체 거래량 검증은 매수 시점에서)
 *
 * 1. KRX 섹터 로테이션에서 IN 시그널 섹터 (없으면 상위 3) 추출
 * 2. 카테고리별 KRX_TOP_STOCKS pool에서 등락률 정렬 후 상위 N
 * 3. 갭상승 필터 적용
 * 4. Rule 12: 저평가 횡보 후보 LLM 추천 (기존 유지)
 * 5. watch_targets에 자동목록으로 갱신
 */

import { KRX_TOP_STOCKS, type MarketStock } from '../config/marketStocks';
import { fetchYahooQuote } from './stockPrice';
import { getSectorRotationContext, type SectorMomentum } from './sectorMomentum';
import { findLowPositionBreakouts, type BreakoutCandidate } from './llm';
import { replaceAutoList } from './watchTargets';
import { getSettings } from './settings';
import logger from '../logger';

interface RankedStock {
  ticker: string;
  name: string;
  sector: string;
  changePercent: number;
  reason: string;
}

const PER_CATEGORY_LIMIT = 10;
const STRONG_SECTOR_MIN = 1;

function tomorrowExpiry(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

function poolForSectors(sectors: string[]): MarketStock[] {
  if (sectors.length === 0) return [];
  return KRX_TOP_STOCKS.filter(s =>
    sectors.some(sec => s.sector === sec || s.sector.includes(sec) || sec.includes(s.sector))
  );
}

/**
 * Pool 내 종목 등락률 + Yahoo quote 조회 → 갭상승 종목 제외.
 * 갭상승 판정: changePercent (Yahoo는 chartPreviousClose 대비 현재가).
 */
async function rankByMomentum(
  pool: readonly MarketStock[],
  limit: number,
  category: string,
  gapUpMaxPercent: number,
): Promise<RankedStock[]> {
  const ranked: RankedStock[] = [];
  const concurrency = 5;
  for (let i = 0; i < pool.length; i += concurrency) {
    const batch = pool.slice(i, i + concurrency);
    const quotes = await Promise.all(
      batch.map(async stock => {
        const quote = await fetchYahooQuote(stock.yahooTicker);
        return { stock, quote };
      })
    );
    for (const { stock, quote } of quotes) {
      if (!quote) continue;

      // 갭상승 필터: 이미 너무 오른 종목은 추격 매수 위험 → 제외
      if (quote.changePercent >= gapUpMaxPercent) {
        logger.debug(
          { ticker: stock.ticker, changePercent: quote.changePercent, gapUpMaxPercent },
          'autoList: 갭상승 종목 제외',
        );
        continue;
      }

      ranked.push({
        ticker: stock.ticker,
        name: stock.name,
        sector: stock.sector,
        changePercent: quote.changePercent,
        reason: `[자동/${category}] ${stock.sector} ${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent}%`,
      });
    }
  }
  ranked.sort((a, b) => b.changePercent - a.changePercent);
  return ranked.slice(0, limit);
}

export interface AutoListBuildResult {
  inserted: number;
  strongSectors: string[];
  topMomentum: number;
  breakoutAdds: number;
  excludedGapUp: number;
}

/** 자동목록 전체 빌드 (매일 아침 08:50 cron) */
export async function buildAutoList(): Promise<AutoListBuildResult> {
  const settings = getSettings();
  const gapUpMax = settings.gapUpMaxPercent ?? 3.0;

  const ctx = await getSectorRotationContext();

  let categories: SectorMomentum[];
  if (ctx.sectors.filter(s => s.rotationSignal === 'IN').length >= STRONG_SECTOR_MIN) {
    categories = ctx.sectors.filter(s => s.rotationSignal === 'IN');
  } else {
    categories = ctx.sectors.slice(0, 3);
  }

  const strongSectorNames = categories.map(c => c.sector);
  logger.info({ strongSectorNames, gapUpMax }, '자동목록 빌드 시작');

  const all: Array<{
    ticker: string;
    name: string;
    sector?: string;
    category?: string;
    reason?: string;
    expiresAt: string;
  }> = [];

  const expiresAt = tomorrowExpiry();
  const seen = new Set<string>();
  let excludedGapUp = 0;

  for (const category of categories) {
    const pool = poolForSectors([category.sector]);
    if (pool.length === 0) continue;
    const beforeCount = pool.length;
    const ranked = await rankByMomentum(pool, PER_CATEGORY_LIMIT, category.sector, gapUpMax);
    excludedGapUp += beforeCount - ranked.length;
    for (const r of ranked) {
      if (seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      all.push({
        ticker: r.ticker,
        name: r.name,
        sector: r.sector,
        category: category.sector,
        reason: r.reason,
        expiresAt,
      });
    }
  }

  // Rule 12: LLM 저평가 횡보 후보
  let breakoutAdds = 0;
  try {
    const candidates: BreakoutCandidate[] = await findLowPositionBreakouts(strongSectorNames, 5);
    for (const c of candidates) {
      if (seen.has(c.ticker)) continue;
      seen.add(c.ticker);
      all.push({
        ticker: c.ticker,
        name: c.name,
        sector: c.sector,
        category: '급등예상',
        reason: `[Rule 12] ${c.reason}`.slice(0, 200),
        expiresAt,
      });
      breakoutAdds++;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Rule 12 LLM step skipped');
  }

  const inserted = replaceAutoList(all);
  logger.info(
    { inserted, breakoutAdds, excludedGapUp, strongSectors: strongSectorNames },
    '자동목록 빌드 완료',
  );
  return {
    inserted,
    strongSectors: strongSectorNames,
    topMomentum: all.length - breakoutAdds,
    breakoutAdds,
    excludedGapUp,
  };
}
