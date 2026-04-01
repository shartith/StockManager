import { queryAll } from '../db';

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

  return rows.filter((row: any) => row.total_buy_qty - row.total_sell_qty > 0).map((row: any) => {
    const quantity = row.total_buy_qty - row.total_sell_qty;
    const avgPrice = row.total_buy_qty > 0 ? row.total_buy_cost / row.total_buy_qty : 0;
    const totalCost = avgPrice * quantity;

    // 배당금 별도 조회
    const divRow = queryAll('SELECT COALESCE(SUM(amount), 0) as total FROM dividends WHERE stock_id = ?', [row.stock_id]);
    const totalDividends = divRow[0]?.total ?? 0;

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

export function getPortfolioSummary(currentPrices?: Map<string, number>): PortfolioSummary {
  const holdings = getPortfolioHoldings();

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalDividends = 0;
  let totalFees = 0;

  const enrichedHoldings = holdings.map(h => {
    const holding = { ...h };
    totalInvested += h.totalCost;
    totalDividends += h.totalDividends;
    totalFees += h.totalFees;

    if (currentPrices && currentPrices.has(h.ticker)) {
      holding.currentPrice = currentPrices.get(h.ticker)!;
      holding.currentValue = Math.round(holding.currentPrice * h.quantity * 100) / 100;
      holding.profitLoss = Math.round((holding.currentValue - h.totalCost) * 100) / 100;
      holding.profitLossPercent = h.totalCost > 0
        ? Math.round((holding.profitLoss / h.totalCost) * 10000) / 100
        : 0;
      totalCurrentValue += holding.currentValue;
    } else {
      totalCurrentValue += h.totalCost;
    }

    return holding;
  });

  // 종목별 자산배분
  const allocationMap = new Map<string, number>();

  enrichedHoldings.forEach(h => {
    const key = `${h.name} (${h.ticker})`;
    const value = h.currentValue ?? h.totalCost;
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
