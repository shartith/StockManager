import { queryAll } from '../db';
import { getUsdKrwRate } from './exchangeRate';

export interface PortfolioHolding {
  stockId: number;
  ticker: string;
  name: string;
  market: string;
  quantity: number;
  avgPrice: number;
  totalCost: number;
  totalFees: number;
  totalDividends: number;
  currentPrice?: number;
  currentValue?: number;
  profitLoss?: number;
  profitLossPercent?: number;
}

export interface PortfolioSummary {
  totalInvested: number;
  totalCurrentValue: number;
  totalProfitLoss: number;
  totalProfitLossPercent: number;
  totalDividends: number;
  totalFees: number;
  holdings: PortfolioHolding[];
  allocation: { label: string; value: number; percent: number }[];
  allocationBy: 'sector' | 'stock';
}

export function getPortfolioHoldings(): PortfolioHolding[] {
  const rows = queryAll(`
    SELECT
      s.id as stock_id,
      s.ticker,
      s.name,
      s.market,
      s.sector,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END), 0) as total_buy_qty,
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END), 0) as total_sell_qty,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END), 0) as total_buy_cost,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.fee ELSE 0 END), 0) as total_buy_fee,
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.quantity * t.price ELSE 0 END), 0) as total_sell_revenue,
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.fee ELSE 0 END), 0) as total_sell_fee
    FROM stocks s
    LEFT JOIN transactions t ON t.stock_id = s.id
    GROUP BY s.id
    HAVING total_buy_qty > 0
  `);

  const filtered = rows.filter((row: any) => row.total_buy_qty - row.total_sell_qty > 0);

  // 배당금 일괄 조회 (N+1 → 1 쿼리)
  const divMap = new Map<number, number>();
  if (filtered.length > 0) {
    const ids = filtered.map((r: any) => r.stock_id);
    const ph = ids.map(() => '?').join(',');
    const divRows = queryAll(
      `SELECT stock_id, COALESCE(SUM(amount), 0) as total FROM dividends WHERE stock_id IN (${ph}) GROUP BY stock_id`,
      ids
    );
    for (const d of divRows) divMap.set(d.stock_id, d.total);
  }

  return filtered.map((row: any) => {
    const quantity = row.total_buy_qty - row.total_sell_qty;
    const avgPrice = row.total_buy_qty > 0 ? row.total_buy_cost / row.total_buy_qty : 0;
    const totalCost = avgPrice * quantity;
    const totalDividends = divMap.get(row.stock_id) ?? 0;

    return {
      stockId: row.stock_id,
      ticker: row.ticker,
      name: row.name,
      market: row.market,
      quantity,
      avgPrice: Math.round(avgPrice * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalFees: Math.round((row.total_buy_fee + row.total_sell_fee) * 100) / 100,
      totalDividends: Math.round(totalDividends * 100) / 100,
    };
  });
}

export async function getPortfolioSummary(currentPrices?: Map<string, number>): Promise<PortfolioSummary> {
  const holdings = getPortfolioHoldings();
  const overseasMarkets = ['NASDAQ', 'NYSE', 'AMEX', 'NASD'];

  // 해외 종목이 있으면 환율 조회
  const hasOverseas = holdings.some(h => overseasMarkets.includes(h.market));
  const usdKrwRate = hasOverseas ? await getUsdKrwRate() : 1;

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalDividends = 0;
  let totalFees = 0;

  const enrichedHoldings = holdings.map(h => {
    const holding = { ...h };
    const isOverseas = overseasMarkets.includes(h.market);
    const rate = isOverseas ? usdKrwRate : 1;

    totalInvested += Math.round(h.totalCost * rate);
    totalDividends += Math.round(h.totalDividends * rate);
    totalFees += Math.round(h.totalFees * rate);

    if (currentPrices && currentPrices.has(h.ticker)) {
      holding.currentPrice = currentPrices.get(h.ticker)!;
      holding.currentValue = Math.round(holding.currentPrice * h.quantity * 100) / 100;
      holding.profitLoss = Math.round((holding.currentValue - h.totalCost) * 100) / 100;
      holding.profitLossPercent = h.totalCost > 0
        ? Math.round((holding.profitLoss / h.totalCost) * 10000) / 100
        : 0;
      totalCurrentValue += Math.round(holding.currentValue * rate);
    } else {
      totalCurrentValue += Math.round(h.totalCost * rate);
    }

    return holding;
  });

  // 종목별 자산배분 (KRW 환산 기준)
  const allocationMap = new Map<string, number>();

  enrichedHoldings.forEach(h => {
    const key = `${h.name} (${h.ticker})`;
    const isOverseas = overseasMarkets.includes(h.market);
    const rate = isOverseas ? usdKrwRate : 1;
    const value = Math.round((h.currentValue ?? h.totalCost) * rate);
    allocationMap.set(key, (allocationMap.get(key) || 0) + value);
  });

  const allocation = Array.from(allocationMap.entries()).map(([label, value]) => ({
    label,
    value: Math.round(value * 100) / 100,
    percent: totalCurrentValue > 0
      ? Math.round((value / totalCurrentValue) * 10000) / 100
      : 0,
  }));

  return {
    totalInvested: Math.round(totalInvested * 100) / 100,
    totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
    totalProfitLoss: Math.round((totalCurrentValue - totalInvested) * 100) / 100,
    totalProfitLossPercent: totalInvested > 0
      ? Math.round(((totalCurrentValue - totalInvested) / totalInvested) * 10000) / 100
      : 0,
    totalDividends: Math.round(totalDividends * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    holdings: enrichedHoldings,
    allocation,
    allocationBy: 'stock' as const,
  };
}

/** 포트폴리오 리스크 컨텍스트 (LLM 입력용) */
export function getPortfolioRiskContext(): {
  totalInvested: number;
  holdingCount: number;
  currentProfitLossPercent: number;
  sectorConcentration: { sector: string; percent: number }[];
  highCorrelationPairs: { pair: string; correlation: number }[];
  optimalWeights: { ticker: string; currentPercent: number; optimalPercent: number; action: string }[];
} {
  const holdings = getPortfolioHoldings();
  const totalInvested = holdings.reduce((sum, h) => sum + h.totalCost, 0);
  const holdingCount = holdings.length;

  // 섹터별 집중도
  const sectorMap = new Map<string, number>();
  for (const h of holdings) {
    const sector = queryAll('SELECT sector FROM stocks WHERE id = ?', [h.stockId])[0]?.sector || '기타';
    sectorMap.set(sector, (sectorMap.get(sector) || 0) + h.totalCost);
  }

  const sectorConcentration = Array.from(sectorMap.entries())
    .filter(([sector]) => sector && sector !== '기타' && sector !== '')
    .map(([sector, value]) => ({
      sector,
      percent: totalInvested > 0 ? Math.round((value / totalInvested) * 100) : 0,
    }))
    .filter(s => s.percent > 0)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5);

  // 종목 간 상관관계 (최근 30일 종가 기반)
  const highCorrelationPairs: { pair: string; correlation: number }[] = [];
  if (holdings.length >= 2) {
    // 종목별 최근 30일 종가 수집
    const priceMap = new Map<string, number[]>();
    for (const h of holdings) {
      const rows = queryAll(
        `SELECT close FROM (
          SELECT stck_clpr as close FROM news_cache LIMIT 0
        ) UNION ALL SELECT close FROM (
          SELECT t.price as close FROM transactions t WHERE t.stock_id = ? ORDER BY t.date DESC LIMIT 30
        )`, [h.stockId]
      );
      // 대안: trade_signals의 indicators에서 가격 추출
      const signals = queryAll(
        'SELECT indicators_json FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 30',
        [h.stockId]
      );
      const closes: number[] = [];
      for (const s of signals) {
        try {
          const ind = JSON.parse(s.indicators_json || '{}');
          if (ind.indicators?.currentPrice) closes.push(ind.indicators.currentPrice);
        } catch {}
      }
      if (closes.length >= 10) priceMap.set(h.ticker, closes);
    }

    // Pearson 상관계수 계산
    const tickers = Array.from(priceMap.keys());
    for (let i = 0; i < tickers.length; i++) {
      for (let j = i + 1; j < tickers.length; j++) {
        const x = priceMap.get(tickers[i])!;
        const y = priceMap.get(tickers[j])!;
        const len = Math.min(x.length, y.length);
        if (len < 10) continue;

        const xSlice = x.slice(0, len);
        const ySlice = y.slice(0, len);
        const xMean = xSlice.reduce((a, b) => a + b, 0) / len;
        const yMean = ySlice.reduce((a, b) => a + b, 0) / len;

        let num = 0, denX = 0, denY = 0;
        for (let k = 0; k < len; k++) {
          const dx = xSlice[k] - xMean;
          const dy = ySlice[k] - yMean;
          num += dx * dy;
          denX += dx * dx;
          denY += dy * dy;
        }
        const den = Math.sqrt(denX * denY);
        const corr = den > 0 ? num / den : 0;

        if (Math.abs(corr) >= 0.7) {
          highCorrelationPairs.push({
            pair: `${tickers[i]}-${tickers[j]}`,
            correlation: Math.round(corr * 100) / 100,
          });
        }
      }
    }
  }

  return {
    totalInvested,
    holdingCount,
    currentProfitLossPercent: 0,
    sectorConcentration,
    highCorrelationPairs,
    optimalWeights: [], // getOptimalPortfolioWeights()는 가격 데이터 필요 — scheduler에서 채움
  };
}

// ─── Markowitz MPT 포트폴리오 최적화 ──────────────────────

export interface OptimalWeight {
  ticker: string;
  name: string;
  currentPercent: number;   // 현재 비중 (%)
  optimalPercent: number;   // 최적 비중 (%)
  action: 'INCREASE' | 'DECREASE' | 'HOLD'; // 조정 방향
  reason: string;
}

/**
 * 간소화된 Markowitz MPT — 수익률/변동성 기반 최적 비중 계산
 * 완전한 공분산 매트릭스 대신, 개별 종목의 샤프비율(수익/위험)로 비중 결정
 */
export function getOptimalPortfolioWeights(
  holdingPrices: Map<string, number[]>  // ticker → 최근 30일 종가 배열
): OptimalWeight[] {
  const holdings = getPortfolioHoldings();
  if (holdings.length < 2) return [];

  const totalValue = holdings.reduce((s, h) => s + h.totalCost, 0);
  if (totalValue === 0) return [];

  // 각 종목의 수익률/변동성 계산
  const metrics: { ticker: string; name: string; currentPct: number; sharpe: number }[] = [];

  for (const h of holdings) {
    const prices = holdingPrices.get(h.ticker);
    if (!prices || prices.length < 10) {
      metrics.push({ ticker: h.ticker, name: h.name, currentPct: (h.totalCost / totalValue) * 100, sharpe: 0 });
      continue;
    }

    // 일별 수익률
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // 샤프비율 (무위험 수익률 ≈ 0 가정)
    const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;

    metrics.push({
      ticker: h.ticker,
      name: h.name,
      currentPct: (h.totalCost / totalValue) * 100,
      sharpe,
    });
  }

  // 샤프비율 기반 최적 비중 (양수만, 음수 종목은 최소 비중)
  const positiveSharpes = metrics.filter(m => m.sharpe > 0);
  const totalPositiveSharpe = positiveSharpes.reduce((s, m) => s + m.sharpe, 0);

  const results: OptimalWeight[] = metrics.map(m => {
    let optimalPct: number;

    if (totalPositiveSharpe > 0 && m.sharpe > 0) {
      // 샤프비율 비례 배분 (최소 5%, 최대 40%)
      optimalPct = Math.max(5, Math.min(40, (m.sharpe / totalPositiveSharpe) * 100));
    } else if (m.sharpe <= 0) {
      // 음수 샤프: 최소 비중 (매도 고려)
      optimalPct = 5;
    } else {
      optimalPct = 100 / metrics.length; // 균등 배분 fallback
    }

    const diff = optimalPct - m.currentPct;
    let action: 'INCREASE' | 'DECREASE' | 'HOLD' = 'HOLD';
    let reason = '';

    if (diff > 5) {
      action = 'INCREASE';
      reason = `샤프비율 양호 — 비중 ${m.currentPct.toFixed(0)}%→${optimalPct.toFixed(0)}% 권장`;
    } else if (diff < -5) {
      action = 'DECREASE';
      reason = `${m.sharpe <= 0 ? '수익/위험 비율 부정적' : '과비중'} — 비중 축소 권장`;
    } else {
      reason = '현재 비중 적정';
    }

    return {
      ticker: m.ticker,
      name: m.name,
      currentPercent: Math.round(m.currentPct * 10) / 10,
      optimalPercent: Math.round(optimalPct * 10) / 10,
      action,
      reason,
    };
  });

  return results;
}
