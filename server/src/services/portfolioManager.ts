import logger from '../logger';
import { queryAll, queryOne } from '../db';
import { getSettings } from './settings';
import { logSystemEvent } from './systemEvent';

// ── Types ──

export interface PromotionCheck {
  allowed: boolean;
  reason: string;
  availableCapital: number;
  currentHoldingCount: number;
  maxHoldings: number;
  targetAllocation: number;
  sectorExposure: number;
  cashPercent: number;
}

export interface RebalanceAction {
  stockId: number;
  ticker: string;
  name: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  currentPercent: number;
  targetPercent: number;
  adjustQuantity: number;
  reason: string;
}

// ── Portfolio State ──

/** Get total portfolio value (invested + available cash) */
export function getTotalPortfolioValue(): { totalValue: number; investedValue: number; cashValue: number; holdingCount: number } {
  // Calculate current invested value from transactions
  const holdings = queryAll(`
    SELECT s.id, s.ticker, s.name, s.market, s.sector,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END), 0) as buy_qty,
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END), 0) as sell_qty,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END), 0) as total_cost
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING buy_qty - sell_qty > 0
  `);

  let investedValue = 0;
  for (const h of holdings) {
    const qty = h.buy_qty - h.sell_qty;
    const avgPrice = h.buy_qty > 0 ? h.total_cost / h.buy_qty : 0;
    investedValue += qty * avgPrice;
  }

  // For total value, use invested + autoTradeMaxInvestment as proxy
  // (Real cash requires KIS API call which is async)
  const settings = getSettings();
  const cashValue = settings.autoTradeMaxInvestment - investedValue;
  const totalValue = Math.max(investedValue + Math.max(cashValue, 0), settings.autoTradeMaxInvestment);

  return {
    totalValue,
    investedValue,
    cashValue: Math.max(cashValue, 0),
    holdingCount: holdings.length,
  };
}

/** Get sector allocation map */
export function getSectorAllocation(): Map<string, { value: number; percent: number; count: number }> {
  // Simplified: query holdings and aggregate by sector
  const allHoldings = queryAll(`
    SELECT s.id, s.sector,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END), 0) as qty,
      CASE WHEN SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END) > 0
        THEN SUM(CASE WHEN t.type='BUY' THEN t.quantity * t.price ELSE 0 END) / SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END)
        ELSE 0 END as avg_price
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING qty > 0
  `);

  const { totalValue } = getTotalPortfolioValue();
  const sectorMap = new Map<string, { value: number; percent: number; count: number }>();

  for (const h of allHoldings) {
    const sector = h.sector || '기타';
    const value = h.qty * h.avg_price;
    const existing = sectorMap.get(sector) || { value: 0, percent: 0, count: 0 };
    existing.value += value;
    existing.count++;
    existing.percent = totalValue > 0 ? (existing.value / totalValue) * 100 : 0;
    sectorMap.set(sector, existing);
  }

  return sectorMap;
}

// ── Promotion Eligibility Check ──

/** Check if a stock can be promoted to watchlist/auto-trade */
export function checkPromotionEligibility(ticker: string, market: string, sector: string): PromotionCheck {
  const settings = getSettings();
  const portfolio = getTotalPortfolioValue();

  const maxHoldings = settings.portfolioMaxHoldings ?? 10;
  const maxPerStockPercent = settings.portfolioMaxPerStockPercent ?? 20;
  const maxSectorPercent = settings.portfolioMaxSectorPercent ?? 40;
  const minCashPercent = settings.portfolioMinCashPercent ?? 10;

  // 1. Check holding count
  if (portfolio.holdingCount >= maxHoldings) {
    return {
      allowed: false,
      reason: `최대 보유 종목 수 초과 (${portfolio.holdingCount}/${maxHoldings})`,
      availableCapital: portfolio.cashValue,
      currentHoldingCount: portfolio.holdingCount,
      maxHoldings,
      targetAllocation: 0,
      sectorExposure: 0,
      cashPercent: portfolio.totalValue > 0 ? (portfolio.cashValue / portfolio.totalValue) * 100 : 0,
    };
  }

  // 2. Calculate target allocation for this stock
  const targetAllocation = Math.min(
    settings.autoTradeMaxPerStock,
    portfolio.totalValue * (maxPerStockPercent / 100)
  );

  // 3. Check sector concentration
  const sectorAlloc = getSectorAllocation();
  const currentSector = sectorAlloc.get(sector || '기타');
  const sectorValue = currentSector?.value ?? 0;
  const newSectorValue = sectorValue + targetAllocation;
  const newSectorPercent = portfolio.totalValue > 0 ? (newSectorValue / portfolio.totalValue) * 100 : 0;

  if (newSectorPercent > maxSectorPercent) {
    return {
      allowed: false,
      reason: `섹터 집중도 초과: ${sector || '기타'} ${newSectorPercent.toFixed(1)}% > ${maxSectorPercent}%`,
      availableCapital: portfolio.cashValue,
      currentHoldingCount: portfolio.holdingCount,
      maxHoldings,
      targetAllocation,
      sectorExposure: newSectorPercent,
      cashPercent: portfolio.totalValue > 0 ? (portfolio.cashValue / portfolio.totalValue) * 100 : 0,
    };
  }

  // 4. Check minimum cash ratio after investment
  const cashAfterInvestment = portfolio.cashValue - targetAllocation;
  const cashPercentAfter = portfolio.totalValue > 0 ? (cashAfterInvestment / portfolio.totalValue) * 100 : 0;

  if (cashPercentAfter < minCashPercent && portfolio.totalValue > 0) {
    return {
      allowed: false,
      reason: `최소 현금 비율 미달: 투자 후 ${cashPercentAfter.toFixed(1)}% < ${minCashPercent}%`,
      availableCapital: portfolio.cashValue,
      currentHoldingCount: portfolio.holdingCount,
      maxHoldings,
      targetAllocation,
      sectorExposure: newSectorPercent,
      cashPercent: cashPercentAfter,
    };
  }

  // 5. Check if we have enough capital for minimum investment
  const minInvestment = targetAllocation * 0.3; // At least 30% of target (1st split buy)
  if (portfolio.cashValue < minInvestment && portfolio.cashValue > 0) {
    return {
      allowed: false,
      reason: `주문가능금액 부족: ${portfolio.cashValue.toLocaleString()}원 < 최소 ${minInvestment.toLocaleString()}원`,
      availableCapital: portfolio.cashValue,
      currentHoldingCount: portfolio.holdingCount,
      maxHoldings,
      targetAllocation,
      sectorExposure: newSectorPercent,
      cashPercent: cashPercentAfter,
    };
  }

  logger.info({ ticker, market, sector, targetAllocation, sectorPercent: newSectorPercent, cashPercent: cashPercentAfter },
    'Promotion eligibility check passed');

  return {
    allowed: true,
    reason: '승격 가능',
    availableCapital: portfolio.cashValue,
    currentHoldingCount: portfolio.holdingCount,
    maxHoldings,
    targetAllocation,
    sectorExposure: newSectorPercent,
    cashPercent: cashPercentAfter,
  };
}

// ── Optimal Quantity Calculation ──

/** Calculate quantity based on portfolio percentage (not fixed amount) */
export function calculateOptimalQuantity(price: number, market: string): number {
  const settings = getSettings();
  const portfolio = getTotalPortfolioValue();

  const maxPerStockPercent = settings.portfolioMaxPerStockPercent ?? 20;
  const maxByPercent = portfolio.totalValue * (maxPerStockPercent / 100);
  const maxByFixed = settings.autoTradeMaxPerStock;
  const effectiveMax = Math.min(maxByPercent, maxByFixed);

  if (effectiveMax <= 0 || price <= 0) return 0;

  const quantity = Math.floor(effectiveMax / price);
  return Math.max(quantity, 0);
}

// ── Rebalancing ──

/** Calculate rebalance actions based on optimal weights */
export function getRebalanceActions(): RebalanceAction[] {
  const settings = getSettings();
  if (!settings.portfolioRebalanceEnabled) return [];

  const portfolio = getTotalPortfolioValue();
  if (portfolio.totalValue <= 0 || portfolio.holdingCount === 0) return [];

  const maxPerStockPercent = settings.portfolioMaxPerStockPercent ?? 20;
  const targetPerStock = Math.min(maxPerStockPercent, 100 / portfolio.holdingCount);

  const holdings = queryAll(`
    SELECT s.id, s.ticker, s.name, s.market,
      COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END), 0) as qty,
      CASE WHEN SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END) > 0
        THEN SUM(CASE WHEN t.type='BUY' THEN t.quantity * t.price ELSE 0 END) / SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END)
        ELSE 0 END as avg_price
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING qty > 0
  `);

  const actions: RebalanceAction[] = [];

  for (const h of holdings) {
    const currentValue = h.qty * h.avg_price;
    const currentPercent = (currentValue / portfolio.totalValue) * 100;
    const diff = currentPercent - targetPerStock;

    // Only rebalance if deviation is significant (>5%)
    if (Math.abs(diff) < 5) {
      actions.push({
        stockId: h.id, ticker: h.ticker, name: h.name,
        action: 'HOLD', currentPercent, targetPercent: targetPerStock,
        adjustQuantity: 0, reason: '적정 비중',
      });
      continue;
    }

    if (diff > 5) {
      // Over-weight: suggest partial sell
      const excessValue = (diff / 100) * portfolio.totalValue;
      const sellQty = Math.floor(excessValue / h.avg_price);
      if (sellQty > 0) {
        actions.push({
          stockId: h.id, ticker: h.ticker, name: h.name,
          action: 'SELL', currentPercent, targetPercent: targetPerStock,
          adjustQuantity: sellQty,
          reason: `비중 초과: ${currentPercent.toFixed(1)}% → ${targetPerStock.toFixed(1)}% 목표`,
        });
      }
    } else if (diff < -5) {
      // Under-weight: suggest additional buy
      const deficitValue = (Math.abs(diff) / 100) * portfolio.totalValue;
      const buyQty = Math.floor(deficitValue / h.avg_price);
      if (buyQty > 0) {
        actions.push({
          stockId: h.id, ticker: h.ticker, name: h.name,
          action: 'BUY', currentPercent, targetPercent: targetPerStock,
          adjustQuantity: buyQty,
          reason: `비중 부족: ${currentPercent.toFixed(1)}% → ${targetPerStock.toFixed(1)}% 목표`,
        });
      }
    }
  }

  return actions;
}

/** Execute rebalancing as trade signals (not actual orders) */
export function generateRebalanceSignals(): { generated: number; actions: RebalanceAction[] } {
  const actions = getRebalanceActions().filter(a => a.action !== 'HOLD');

  if (actions.length === 0) {
    logger.info('리밸런싱 필요 없음 — 모든 종목 적정 비중');
    return { generated: 0, actions: [] };
  }

  // Log rebalance suggestions as system events (advisory, not auto-executed)
  for (const action of actions) {
    logSystemEvent(
      'INFO',
      'REBALANCE',
      `리밸런싱 제안: ${action.ticker} ${action.action}`,
      `${action.reason} (${action.adjustQuantity}주 ${action.action === 'BUY' ? '추가매수' : '부분매도'})`,
      action.ticker
    );
  }

  logger.info({ count: actions.length }, '리밸런싱 제안 생성 완료');
  return { generated: actions.length, actions };
}
