/**
 * 포트폴리오 요약 (v5.0.0 슬림화).
 *
 * v5.0 이전: Markowitz MPT, 상관계수, 섹터집중도, 최적 비중 — 학습 인프라 의존.
 * v5.0+: 보유종목 + 평가금액 + 손익 단순 합계만.
 * 배당금 / 상관관계 / 최적가중치 모두 제거.
 */

import { queryAll } from '../db';

export interface PortfolioHolding {
  stockId: number;
  ticker: string;
  name: string;
  market: string;
  sector: string;
  quantity: number;
  avgPrice: number;
  totalCost: number;
  totalFees: number;
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
  totalFees: number;
  holdings: PortfolioHolding[];
  allocation: { label: string; value: number; percent: number }[];
  allocationBy: 'stock';
}

export function getPortfolioHoldings(): PortfolioHolding[] {
  const rows = queryAll<{
    stock_id: number;
    ticker: string;
    name: string;
    market: string;
    sector: string;
    total_buy_qty: number;
    total_sell_qty: number;
    total_buy_cost: number;
    total_buy_fee: number;
    total_sell_fee: number;
  }>(`
    SELECT
      s.id as stock_id,
      s.ticker,
      s.name,
      COALESCE(s.market, 'KRX') as market,
      COALESCE(s.sector, '') as sector,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END), 0) as total_buy_qty,
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END), 0) as total_sell_qty,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END), 0) as total_buy_cost,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.fee ELSE 0 END), 0) as total_buy_fee,
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.fee ELSE 0 END), 0) as total_sell_fee
    FROM stocks s
    LEFT JOIN transactions t ON t.stock_id = s.id AND t.deleted_at IS NULL
    WHERE s.deleted_at IS NULL
    GROUP BY s.id
    HAVING total_buy_qty > 0
  `);

  return rows
    .filter(row => row.total_buy_qty - row.total_sell_qty > 0)
    .map(row => {
      const quantity = row.total_buy_qty - row.total_sell_qty;
      const avgPrice = row.total_buy_qty > 0 ? row.total_buy_cost / row.total_buy_qty : 0;
      const totalCost = avgPrice * quantity;
      return {
        stockId: row.stock_id,
        ticker: row.ticker,
        name: row.name,
        market: row.market,
        sector: row.sector,
        quantity,
        avgPrice: Math.round(avgPrice * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        totalFees: Math.round((row.total_buy_fee + row.total_sell_fee) * 100) / 100,
      };
    });
}

export function getPortfolioSummary(currentPrices?: Map<string, number>): PortfolioSummary {
  const holdings = getPortfolioHoldings();

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalFees = 0;

  const enriched = holdings.map(h => {
    const holding = { ...h };
    totalInvested += Math.round(h.totalCost);
    totalFees += Math.round(h.totalFees);

    if (currentPrices && currentPrices.has(h.ticker)) {
      holding.currentPrice = currentPrices.get(h.ticker)!;
      holding.currentValue = Math.round(holding.currentPrice * h.quantity * 100) / 100;
      holding.profitLoss = Math.round((holding.currentValue - h.totalCost) * 100) / 100;
      holding.profitLossPercent = h.totalCost > 0
        ? Math.round((holding.profitLoss / h.totalCost) * 10000) / 100
        : 0;
      totalCurrentValue += Math.round(holding.currentValue);
    } else {
      totalCurrentValue += Math.round(h.totalCost);
    }
    return holding;
  });

  const allocation = enriched.map(h => {
    const value = Math.round(h.currentValue ?? h.totalCost);
    return {
      label: `${h.name} (${h.ticker})`,
      value,
      percent: totalCurrentValue > 0 ? Math.round((value / totalCurrentValue) * 10000) / 100 : 0,
    };
  });

  return {
    totalInvested: Math.round(totalInvested * 100) / 100,
    totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
    totalProfitLoss: Math.round((totalCurrentValue - totalInvested) * 100) / 100,
    totalProfitLossPercent: totalInvested > 0
      ? Math.round(((totalCurrentValue - totalInvested) / totalInvested) * 10000) / 100
      : 0,
    totalFees: Math.round(totalFees * 100) / 100,
    holdings: enriched,
    allocation,
    allocationBy: 'stock' as const,
  };
}
