/**
 * 포지션 사이징 (v5.2.0).
 *
 * v5.2: settings.autoTradeMaxInvestment 의존 제거. 호출처가 KIS 잔고를 받아서 전달.
 * 단순 분할: cashAmount ÷ positionMaxPositions ±5%.
 */

import { queryAll } from '../db';
import { getSettings } from './settings';

export interface PortfolioState {
  investedValue: number;
  holdingCount: number;
}

/** 보유 종목 수 + 평균단가 합 (cash는 KIS API에서 별도 조회). */
export function getHoldingsState(): PortfolioState {
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

  return { investedValue, holdingCount: holdings.length };
}

export interface PositionSizingResult {
  allowed: boolean;
  reason?: string;
  maxBuyAmount: number;
  maxBuyQuantity: number;
}

/**
 * 매수 전 포지션 사이징 게이트 (v5.2).
 *
 * 정책 (사용자 결정):
 *   1. 단가 > 가용현금×0.9    → 차단 (1주도 못 살 정도로 비쌈)
 *   2. 단가 ≤ 종목당 한도×1.05 → floor(한도/단가)주 매수 (정상 분할)
 *   3. 단가 > 종목당 한도×1.05 → 1주만 매수 (한도 초과지만 가용 가능)
 *
 *   종목당 한도 = cashAmount / positionMaxPositions  (1/N 고정)
 *
 * @param price 주문가 (KRW)
 * @param cashAmount KIS API에서 가져온 현재 가용 현금
 */
export function checkPositionSizingRules(
  price: number,
  cashAmount: number,
): PositionSizingResult {
  const settings = getSettings();
  const { holdingCount } = getHoldingsState();
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
  if (cashAmount <= 0) {
    return { allowed: false, reason: '가용 현금 없음', maxBuyAmount: 0, maxBuyQuantity: 0 };
  }

  // Step 1: 단가가 가용현금 90% 초과면 차단 (1주도 못 살 정도)
  const maxAffordable = cashAmount * 0.9;
  if (price > maxAffordable) {
    return {
      allowed: false,
      reason: `단가 ${price.toLocaleString()}원 > 가용현금 90% (${Math.round(maxAffordable).toLocaleString()}원)`,
      maxBuyAmount: 0,
      maxBuyQuantity: 0,
    };
  }

  // Step 2: 종목당 한도 산정 (1/N)
  const perStockBudget = cashAmount / maxPositions;
  const budgetCeiling = perStockBudget * 1.05; // ±5% 허용

  // Step 3: 한도 내 → 정상 분할, 한도 초과 → 1주만
  let qty = Math.floor(budgetCeiling / price);
  if (qty <= 0) {
    qty = 1; // 한도 초과지만 maxAffordable 이내 → 1주 허용 (절대 2주 이상 X)
  }

  return {
    allowed: true,
    maxBuyAmount: qty * price,
    maxBuyQuantity: qty,
  };
}
