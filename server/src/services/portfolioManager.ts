/**
 * 포지션 사이징 (v5.1.0).
 *
 * v5.1: positionMaxRatio/positionMinCashRatio 제거 → autoTradeMaxInvestment ÷ positionMaxPositions
 *       기반 단순 분할로 변경 (사용자 안: 100만원 / 5종목 = 20만원).
 *
 * dailyStrategy는 직접 perStockBudget 계산해서 호출. kisOrder는 이 함수로 안전망 체크.
 */

import { queryAll } from '../db';
import { getSettings } from './settings';

export interface PortfolioState {
  totalValue: number;
  investedValue: number;
  cashValue: number;
  holdingCount: number;
}

export function getTotalPortfolioValue(): PortfolioState {
  const holdings = queryAll<{
    buy_qty: number; sell_qty: number; total_cost: number;
  }>(`
    SELECT
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

export interface PositionSizingResult {
  allowed: boolean;
  reason?: string;
  maxBuyAmount: number;
  maxBuyQuantity: number;
}

/**
 * 매수 전 포지션 사이징 게이트.
 * v5.1: 단순 분할 — totalBudget ÷ positionMaxPositions, ±5% 허용.
 *
 * @param price 주문가 (KRW)
 */
export function checkPositionSizingRules(
  price: number,
  _market: string,
): PositionSizingResult {
  const settings = getSettings();
  const portfolio = getTotalPortfolioValue();

  const totalBudget = portfolio.totalValue;
  const cash = portfolio.cashValue;
  const holdingCount = portfolio.holdingCount;
  const maxPositions = settings.positionMaxPositions;

  if (holdingCount >= maxPositions) {
    return {
      allowed: false,
      reason: `최대 보유 종목 수 초과 (${holdingCount}/${maxPositions})`,
      maxBuyAmount: 0,
      maxBuyQuantity: 0,
    };
  }

  if (price <= 0) {
    return { allowed: false, reason: '잘못된 가격', maxBuyAmount: 0, maxBuyQuantity: 0 };
  }

  // 종목당 한도: 총 예산 ÷ 보유 종목 수, ±5% 허용
  const perStockBudget = totalBudget / Math.max(maxPositions, 1);
  const maxAmount = perStockBudget * 1.05;

  // 가용 현금 한도 (90%)
  const buyAmount = Math.min(maxAmount, cash * 0.9);
  if (buyAmount <= 0) {
    return { allowed: false, reason: '매수 가능 금액 없음', maxBuyAmount: 0, maxBuyQuantity: 0 };
  }

  const qty = Math.floor(buyAmount / price);
  if (qty <= 0) {
    return {
      allowed: false,
      reason: `주가(${price.toLocaleString()}원)가 종목당 한도(${Math.round(buyAmount).toLocaleString()}원) 초과`,
      maxBuyAmount: buyAmount,
      maxBuyQuantity: 0,
    };
  }

  return { allowed: true, maxBuyAmount: buyAmount, maxBuyQuantity: qty };
}
