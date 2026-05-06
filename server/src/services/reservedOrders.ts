/**
 * Reserved Orders — 지정가 대기 매수/매도.
 *
 * 사용자가 "삼성전자 70,000원 도달 시 매수, 80,000원 도달 시 매도" 같은 조건부
 * 주문을 등록하면, 장 중 5분 간격으로 dailyStrategy 루프가 현재가를 비교하여
 * 조건 충족 시 KIS 주문을 자동 실행한다.
 *
 * v5.0.0: 이전 orderManager.ts(자동매매 분기 분할 로직 포함)를 제거하고
 *         "지정가 대기 단순 트리거"만 남긴 가벼운 모듈로 재작성.
 */

import { queryAll, queryOne, execute, withTransaction } from '../db';
import logger from '../logger';

export type Condition = 'BELOW' | 'ABOVE';
export type OrderType = 'BUY' | 'SELL';
export type ReservedStatus = 'ACTIVE' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED';

export interface ReservedOrder {
  id: number;
  stockId: number;
  ticker: string;
  market: string;
  orderType: OrderType;
  targetPrice: number;
  condition: Condition;
  quantity: number;
  status: ReservedStatus;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
  executedAt: string | null;
}

interface ReservedRow {
  id: number;
  stock_id: number;
  ticker: string;
  market: string;
  order_type: OrderType;
  target_price: number;
  condition: Condition;
  quantity: number;
  status: ReservedStatus;
  reason: string;
  expires_at: string | null;
  created_at: string;
  executed_at: string | null;
}

function rowToOrder(row: ReservedRow): ReservedOrder {
  return {
    id: row.id,
    stockId: row.stock_id,
    ticker: row.ticker,
    market: row.market,
    orderType: row.order_type,
    targetPrice: row.target_price,
    condition: row.condition,
    quantity: row.quantity,
    status: row.status,
    reason: row.reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    executedAt: row.executed_at,
  };
}

// ── CRUD ──

/** 활성 예약 주문 전체 조회 */
export function listActive(): ReservedOrder[] {
  const rows = queryAll<ReservedRow>(
    `SELECT * FROM reserved_orders
     WHERE status = 'ACTIVE'
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
     ORDER BY created_at DESC`,
  );
  return rows.map(rowToOrder);
}

/** 종목별 활성 예약 주문 */
export function listActiveByStock(stockId: number): ReservedOrder[] {
  const rows = queryAll<ReservedRow>(
    `SELECT * FROM reserved_orders
     WHERE stock_id = ? AND status = 'ACTIVE'
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
    [stockId],
  );
  return rows.map(rowToOrder);
}

export function findById(id: number): ReservedOrder | null {
  const row = queryOne<ReservedRow>('SELECT * FROM reserved_orders WHERE id = ?', [id]);
  return row ? rowToOrder(row) : null;
}

/** 지정가 대기 주문 등록.
 *  BUY: 일반적으로 condition='BELOW' (target_price 이하로 떨어지면 매수)
 *  SELL: 일반적으로 condition='ABOVE' (target_price 이상 오르면 매도)
 *  하지만 양쪽 모두 자유롭게 조합 가능 (BUY ABOVE = breakout 매수 등). */
export function create(args: {
  stockId: number;
  ticker: string;
  market?: string;
  orderType: OrderType;
  targetPrice: number;
  condition: Condition;
  quantity?: number;
  reason?: string;
  expiresAt?: string | null;
}): ReservedOrder {
  const {
    stockId, ticker, market = 'KRX', orderType, targetPrice,
    condition, quantity = 0, reason = '', expiresAt = null,
  } = args;

  if (targetPrice <= 0) throw new Error('targetPrice must be > 0');
  if (orderType === 'SELL' && quantity > 0) {
    // 보유 수량 검증은 호출처에서. 여기서는 sanity만.
  }

  const result = execute(
    `INSERT INTO reserved_orders
       (stock_id, ticker, market, order_type, target_price, condition, quantity, status, reason, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [stockId, ticker, market, orderType, targetPrice, condition, quantity, reason, expiresAt],
  );
  const created = findById(result.lastId);
  if (!created) throw new Error('reservedOrder create failed');
  logger.info(
    { id: created.id, ticker, orderType, targetPrice, condition, quantity },
    'reservedOrder created',
  );
  return created;
}

/** 사용자가 직접 취소 */
export function cancel(id: number): boolean {
  const result = execute(
    `UPDATE reserved_orders SET status = 'CANCELLED' WHERE id = ? AND status = 'ACTIVE'`,
    [id],
  );
  if (result.changes > 0) logger.info({ id }, 'reservedOrder cancelled');
  return result.changes > 0;
}

/** 만료된 ACTIVE → EXPIRED */
export function expireStale(): number {
  const result = execute(
    `UPDATE reserved_orders
       SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime('now')`,
  );
  if (result.changes > 0) logger.info({ count: result.changes }, 'reservedOrders expired');
  return result.changes;
}

// ── 트리거 평가 ──

/** condition 평가: 현재가가 target에 도달했는지 */
export function isTriggered(order: ReservedOrder, currentPrice: number): boolean {
  if (currentPrice <= 0) return false;
  if (order.condition === 'BELOW') return currentPrice <= order.targetPrice;
  return currentPrice >= order.targetPrice;
}

/**
 * 주문이 체결됐다고 표기 (KIS 주문 성공 후 호출).
 * 주문 실행 자체는 호출처(dailyStrategy)에서 kisOrder.executeOrder()로 처리.
 */
export function markExecuted(id: number): void {
  execute(
    `UPDATE reserved_orders
       SET status = 'EXECUTED', executed_at = datetime('now')
     WHERE id = ? AND status = 'ACTIVE'`,
    [id],
  );
  logger.info({ id }, 'reservedOrder executed');
}

/** 주문 실행 실패 시 재시도 가능하도록 ACTIVE 유지하되 reason 기록 (선택). */
export function recordExecutionAttempt(id: number, note: string): void {
  execute(
    `UPDATE reserved_orders SET reason = ? WHERE id = ?`,
    [note, id],
  );
}
