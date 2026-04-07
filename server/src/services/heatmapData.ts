import { fetchYahooQuote } from './stockPrice';
import { KRX_TOP_STOCKS, US_TOP_STOCKS, US_SECTOR_ETFS, type MarketStock } from '../config/marketStocks';
import { queryAll } from '../db';
import logger from '../logger';

// ── Types ──

export interface HeatmapStock {
  ticker: string;
  name: string;
  sector: string;
  market: string;
  price: number;
  changePercent: number;
  weight: number;
}

export interface HeatmapSector {
  sector: string;
  stocks: HeatmapStock[];
  totalWeight: number;
  avgChangePercent: number;
}

export interface HeatmapData {
  mode: 'portfolio' | 'market';
  market?: string;
  sectors: HeatmapSector[];
  updatedAt: string;
  totalStocks: number;
  advancers: number;
  decliners: number;
}

// ── Cache ──

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const cache = new Map<string, { data: HeatmapData; fetchedAt: number }>();

function getCached(key: string): HeatmapData | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCache(key: string, data: HeatmapData): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}

// ── Fetch prices in parallel with concurrency limit ──

async function fetchPrices(
  stocks: readonly MarketStock[],
  concurrency = 5,
): Promise<Map<string, { price: number; changePercent: number }>> {
  const results = new Map<string, { price: number; changePercent: number }>();
  const queue = [...stocks];

  async function worker() {
    while (queue.length > 0) {
      const stock = queue.shift();
      if (!stock) break;
      try {
        const quote = await fetchYahooQuote(stock.yahooTicker);
        if (quote) {
          results.set(stock.ticker, quote);
        }
      } catch {
        // Skip failed fetches
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, stocks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

// ── Group stocks into sectors ──

function groupBySector(stocks: HeatmapStock[]): HeatmapSector[] {
  const sectorMap = new Map<string, HeatmapStock[]>();

  for (const stock of stocks) {
    const sector = stock.sector || '기타';
    if (!sectorMap.has(sector)) {
      sectorMap.set(sector, []);
    }
    sectorMap.get(sector)!.push(stock);
  }

  const sectors: HeatmapSector[] = [];
  for (const [sector, sectorStocks] of sectorMap) {
    const totalWeight = sectorStocks.reduce((sum, s) => sum + s.weight, 0);
    const avgChangePercent = totalWeight > 0
      ? sectorStocks.reduce((sum, s) => sum + s.changePercent * s.weight, 0) / totalWeight
      : 0;

    sectors.push({
      sector,
      stocks: sectorStocks.sort((a, b) => b.weight - a.weight),
      totalWeight,
      avgChangePercent: Math.round(avgChangePercent * 100) / 100,
    });
  }

  return sectors.sort((a, b) => b.totalWeight - a.totalWeight);
}

// ── Portfolio Heatmap ──

export async function getPortfolioHeatmap(): Promise<HeatmapData> {
  const cached = getCached('portfolio');
  if (cached) return cached;

  // Get holdings with current values
  const holdings = queryAll(`
    SELECT s.ticker, s.name, s.market, s.sector,
           SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) as quantity,
           SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END) as total_cost
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    GROUP BY s.id
    HAVING quantity > 0
  `);

  if (holdings.length === 0) {
    const empty: HeatmapData = {
      mode: 'portfolio',
      sectors: [],
      updatedAt: new Date().toISOString(),
      totalStocks: 0,
      advancers: 0,
      decliners: 0,
    };
    return empty;
  }

  // Build yahoo ticker map
  const tickerMap: MarketStock[] = holdings.map((h: any) => {
    const isKrx = !h.market || h.market === 'KRX';
    const suffix = isKrx ? '.KS' : '';
    return {
      ticker: h.ticker,
      yahooTicker: isKrx ? `${h.ticker}${suffix}` : h.ticker,
      name: h.name,
      sector: h.sector || '기타',
    };
  });

  const prices = await fetchPrices(tickerMap);

  // Calculate total portfolio value for weighting
  const totalValue = holdings.reduce((sum: number, h: any) => {
    const quote = prices.get(h.ticker);
    return sum + (quote ? quote.price * h.quantity : h.total_cost);
  }, 0);

  const stocks: HeatmapStock[] = holdings.map((h: any) => {
    const quote = prices.get(h.ticker);
    const currentValue = quote ? quote.price * h.quantity : h.total_cost;
    return {
      ticker: h.ticker,
      name: h.name,
      sector: h.sector || '기타',
      market: h.market || 'KRX',
      price: quote?.price ?? 0,
      changePercent: quote?.changePercent ?? 0,
      weight: totalValue > 0 ? currentValue / totalValue : 1 / holdings.length,
    };
  });

  const data: HeatmapData = {
    mode: 'portfolio',
    sectors: groupBySector(stocks),
    updatedAt: new Date().toISOString(),
    totalStocks: stocks.length,
    advancers: stocks.filter(s => s.changePercent > 0).length,
    decliners: stocks.filter(s => s.changePercent < 0).length,
  };

  setCache('portfolio', data);
  return data;
}

// ── Market Heatmap (KRX / US) ──

export async function getMarketHeatmap(market: 'KRX' | 'US'): Promise<HeatmapData> {
  const cacheKey = `market:${market}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const stockList = market === 'KRX'
    ? KRX_TOP_STOCKS
    : [...US_SECTOR_ETFS, ...US_TOP_STOCKS];

  logger.info({ market, count: stockList.length }, 'Fetching heatmap prices');

  const prices = await fetchPrices(stockList, market === 'KRX' ? 3 : 5);

  // Equal weight within sector for market mode
  const sectorCounts = new Map<string, number>();
  for (const s of stockList) {
    sectorCounts.set(s.sector, (sectorCounts.get(s.sector) || 0) + 1);
  }

  const stocks: HeatmapStock[] = [];
  for (const s of stockList) {
    const quote = prices.get(s.ticker);
    if (!quote) continue;

    stocks.push({
      ticker: s.ticker,
      name: s.name,
      sector: s.sector,
      market,
      price: quote.price,
      changePercent: quote.changePercent,
      weight: 1 / (sectorCounts.get(s.sector) || 1),
    });
  }

  const data: HeatmapData = {
    mode: 'market',
    market,
    sectors: groupBySector(stocks),
    updatedAt: new Date().toISOString(),
    totalStocks: stocks.length,
    advancers: stocks.filter(s => s.changePercent > 0).length,
    decliners: stocks.filter(s => s.changePercent < 0).length,
  };

  setCache(cacheKey, data);
  logger.info({ market, fetched: prices.size, total: stockList.length }, 'Heatmap data cached');
  return data;
}

/** Invalidate cache (e.g., after manual refresh) */
export function invalidateHeatmapCache(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}
