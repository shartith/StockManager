/**
 * 주문 관리 서비스
 * - 미체결 주문 자동 정정/취소
 * - 예약 주문 (목표가 도달 시 자동 실행)
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { queryAll, queryOne, execute } from '../db';
import { kisApiCall } from './apiQueue';
import { executeOrder, getCurrentPrice } from './kisOrder';
import { logSystemEvent } from './systemEvent';
import { createNotification } from './notification';

// ─── 미체결 주문 관리 ──────────────────────────────────

/** KIS API 미체결 조회 (정정/취소 가능 주문) */
async function fetchUnfilledOrders(): Promise<any[]> {
  const settings = getSettings();
  if (!settings.kisAppKey || !settings.kisAppSecret) return [];

  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    const token = await getAccessToken();
    const trId = isVirtual ? 'VTTC8036R' : 'TTTC8036R';

    return await kisApiCall(async () => {
      const params = new URLSearchParams({
        CANO: settings.kisAccountNo,
        ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
        INQR_DVSN_1: '0',
        INQR_DVSN_2: '0',
      });

      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: trId, custtype: 'P',
          },
        }
      );

      if (!response.ok) return [];
      const data: any = await response.json();
      if (data.rt_cd !== '0') return [];
      return data.output || [];
    }, 'unfilled-orders');
  } catch {
    return [];
  }
}

/** KIS API 주문 취소 */
async function cancelOrder(orgOrdNo: string, orgOrdQty: number, ticker: string): Promise<boolean> {
  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    const settings = getSettings();
    const token = await getAccessToken();
    const trId = isVirtual ? 'VTTC0803U' : 'TTTC0803U';

    return await kisApiCall(async () => {
      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/trading/order-rvsecncl`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: trId, custtype: 'P',
          },
          body: JSON.stringify({
            CANO: settings.kisAccountNo,
            ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
            KRX_FWDG_ORD_ORGNO: '',
            ORGN_ODNO: orgOrdNo,
            ORD_DVSN: '00',
            RVSE_CNCL_DVSN_CD: '02', // 02=취소
            ORD_QTY: String(orgOrdQty),
            ORD_UNPR: '0',
            QTY_ALL_ORD_YN: 'Y', // 잔량 전부
          }),
        }
      );

      if (!response.ok) return false;
      const data: any = await response.json();
      return data.rt_cd === '0';
    }, `cancel-${ticker}`);
  } catch {
    return false;
  }
}

/** 미체결 주문 자동 관리 (10분 모니터링에서 호출) */
export async function manageUnfilledOrders() {
  const unfilled = await fetchUnfilledOrders();
  if (unfilled.length === 0) return;

  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();

  for (const order of unfilled) {
    const ticker = order.pdno || '';
    const ordNo = order.odno || '';
    const ordQty = Number(order.psbl_qty || order.ord_qty || 0);
    const ordTime = order.ord_tmd || ''; // HHMMSS

    if (!ordNo || ordQty <= 0) continue;

    // 주문 시간 파싱
    const ordHour = parseInt(ordTime.slice(0, 2) || '0', 10);
    const ordMin = parseInt(ordTime.slice(2, 4) || '0', 10);
    const elapsedMin = (currentHour * 60 + currentMin) - (ordHour * 60 + ordMin);

    // 장 마감 20분 전 (14:40~) → 전량 취소
    if (currentHour >= 14 && currentMin >= 40) {
      const cancelled = await cancelOrder(ordNo, ordQty, ticker);
      if (cancelled) {
        await logSystemEvent('WARN', 'ORDER_UNFILLED',
          `장 마감 전 미체결 취소: ${ticker}`,
          `주문번호 ${ordNo}, 수량 ${ordQty}`, ticker);
        createNotification({
          type: 'AUTO_TRADE' as any, title: '미체결 취소',
          message: `${ticker} 미체결 주문 ${ordQty}주 장 마감 전 자동 취소`,
          ticker, actionUrl: '/transactions',
        });
      }
      continue;
    }

    // 1시간 이상 미체결 → 취소 후 시장가 재주문
    if (elapsedMin >= 60) {
      const cancelled = await cancelOrder(ordNo, ordQty, ticker);
      if (cancelled) {
        const stock = queryOne('SELECT id, market FROM stocks WHERE ticker = ?', [ticker]);
        if (stock) {
          await executeOrder({
            stockId: stock.id, ticker, market: stock.market as any,
            orderType: 'BUY', quantity: ordQty, price: 0, // 시장가
          });
          await logSystemEvent('WARN', 'ORDER_UNFILLED',
            `1시간 미체결 → 시장가 재주문: ${ticker}`,
            `원주문 ${ordNo} 취소 후 시장가 ${ordQty}주 재주문`, ticker);
        }
      }
      continue;
    }

    // 30분 이상 미체결 → 현재가로 정정 (지정가 갱신)
    if (elapsedMin >= 30) {
      await logSystemEvent('INFO', 'ORDER_UNFILLED',
        `30분 미체결: ${ticker}`,
        `주문번호 ${ordNo}, 경과 ${elapsedMin}분 — 다음 사이클에서 가격 정정 예정`, ticker);
    }
  }
}

// ─── 예약 주문 관리 ──────────────────────────────────

/** 예약 주문 생성 (LLM의 WAIT_DIP 판단 시 자동 호출) */
export function createReservedOrder(
  stockId: number, ticker: string, market: string,
  orderType: 'BUY' | 'SELL', targetPrice: number,
  condition: 'BELOW' | 'ABOVE', quantity: number = 0, reason: string = '',
) {
  // 기존 동일 종목 예약이 있으면 갱신
  const existing = queryOne(
    "SELECT id FROM reserved_orders WHERE ticker = ? AND order_type = ? AND status = 'ACTIVE'",
    [ticker, orderType]
  );
  if (existing) {
    execute(
      "UPDATE reserved_orders SET target_price = ?, condition = ?, quantity = ?, reason = ?, expires_at = datetime('now', '+3 days') WHERE id = ?",
      [targetPrice, condition, quantity, reason, existing.id]
    );
    return existing.id;
  }

  const { lastId } = execute(
    "INSERT INTO reserved_orders (stock_id, ticker, market, order_type, target_price, condition, quantity, reason, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+3 days'))",
    [stockId, ticker, market, orderType, targetPrice, condition, quantity, reason]
  );
  return lastId;
}

/** 예약 주문 체크 및 실행 (10분 모니터링에서 호출) */
export async function checkReservedOrders(prices: Map<string, number>) {
  const activeOrders = queryAll("SELECT * FROM reserved_orders WHERE status = 'ACTIVE'");

  for (const order of activeOrders) {
    const currentPrice = prices.get(order.ticker);
    if (!currentPrice) continue;

    // 만료 체크
    if (order.expires_at && new Date(order.expires_at) < new Date()) {
      execute("UPDATE reserved_orders SET status = 'EXPIRED' WHERE id = ?", [order.id]);
      continue;
    }

    // 조건 체크: BELOW = 가격이 목표가 이하, ABOVE = 가격이 목표가 이상
    const triggered = order.condition === 'BELOW'
      ? currentPrice <= order.target_price
      : currentPrice >= order.target_price;

    if (triggered) {
      try {
        const result = await executeOrder({
          stockId: order.stock_id, ticker: order.ticker, market: order.market as any,
          orderType: order.order_type, quantity: order.quantity || 0, price: 0,
        });

        if (result.success) {
          execute("UPDATE reserved_orders SET status = 'EXECUTED', executed_at = datetime('now') WHERE id = ?", [order.id]);
          await logSystemEvent('INFO', 'RESERVED_ORDER',
            `예약 주문 실행: ${order.ticker} ${order.order_type}`,
            `목표가 ${order.target_price} 도달 (현재가 ${currentPrice}), ${result.quantity}주 체결`, order.ticker);
          createNotification({
            type: 'AUTO_TRADE' as any, title: '예약 주문 체결',
            message: `${order.ticker} ${order.order_type} ${result.quantity}주 — 목표가 ${order.target_price} 도달`,
            ticker: order.ticker, market: order.market, actionUrl: '/transactions',
          });
        }
      } catch (err: any) {
        await logSystemEvent('ERROR', 'ORDER_FAILED',
          `예약 주문 실행 실패: ${order.ticker}`,
          err.message, order.ticker);
      }
    }
  }
}
