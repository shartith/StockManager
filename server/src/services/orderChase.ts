/**
 * Order Chase — 미체결 주문 가격 갱신 (v5.2.0).
 *
 * 사용자 요구:
 *   1. 5분 모니터링 중 SUBMITTED 주문이 N분 이상 미체결이면 가격 변경 후 재제출
 *   2. 특히 EOD 매도(15:00 익절 / 15:20 강제정리)가 체결 안 되면 장 마감(15:30)까지 시장가로 강제
 *
 * 가격 단계 (chase_level):
 *   매수 (BUY): currentPrice × 0.995 → currentPrice → ×1.005 → ×1.01 → 시장가
 *   매도 (SELL): 시장가 → currentPrice × 0.995 → ×0.99 → ×0.985 → 시장가
 *
 * 호출:
 *   - dailyStrategy 5분 tick: chaseStaleOrders(eod=false) — stale > 5분
 *   - 15:25 cron: chaseStaleOrders(eod=true) — 모든 SUBMITTED 시장가로
 */

import { queryAll, execute } from '../db';
import { resubmitOrder } from './kisOrder';
import { getKisStockSnapshot } from './stockPrice';
import { getAccessToken } from './kisAuth';
import { logSystemEvent } from './systemEvent';
import logger from '../logger';

const STALE_MIN = 5;          // 5분 이상 미체결이면 chase 시작
const MAX_CHASE_LEVEL = 4;    // 4단계까지는 지정가, 그 이상은 시장가

interface StaleOrder {
  id: number;
  stock_id: number;
  ticker: string;
  order_type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  kis_order_no: string;
  chase_level: number;
  created_at: string;
}

function nextPrice(orderType: 'BUY' | 'SELL', currentPrice: number, level: number): number {
  // BUY: 점점 비싸게, SELL: 점점 싸게 (체결 가속)
  if (orderType === 'BUY') {
    const offsets = [0.995, 1.000, 1.005, 1.010];
    return Math.floor(currentPrice * (offsets[level] ?? 1.010));
  }
  // SELL
  const offsets = [1.000, 0.995, 0.990, 0.985];
  return Math.floor(currentPrice * (offsets[level] ?? 0.985));
}

export async function chaseStaleOrders(eod: boolean = false): Promise<{ chased: number; resubmitted: number; marketed: number; failed: number }> {
  const minAge = eod ? 0 : STALE_MIN;
  const orders = queryAll<StaleOrder>(`
    SELECT at.id, at.stock_id, s.ticker, at.order_type, at.quantity, at.price,
           COALESCE(at.kis_order_no, '') as kis_order_no,
           COALESCE(at.chase_level, 0) as chase_level,
           at.created_at
    FROM auto_trades at
    JOIN stocks s ON s.id = at.stock_id
    WHERE at.status = 'SUBMITTED'
      AND date(at.created_at) = date('now')
      AND datetime(at.created_at) <= datetime('now', '-${minAge} minutes')
      AND at.kis_order_no != ''
    ORDER BY at.created_at ASC
  `);

  if (orders.length === 0) return { chased: 0, resubmitted: 0, marketed: 0, failed: 0 };

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'orderChase: KIS auth failed, skip');
    return { chased: 0, resubmitted: 0, marketed: 0, failed: 0 };
  }

  let resubmitted = 0;
  let marketed = 0;
  let failed = 0;

  for (const o of orders) {
    const newLevel = o.chase_level + 1;
    const useMarket = eod || newLevel > MAX_CHASE_LEVEL;

    let newPrice = 0;
    if (!useMarket) {
      const snap = await getKisStockSnapshot(o.ticker, token);
      const cur = snap?.price ?? o.price;
      newPrice = nextPrice(o.order_type, cur, newLevel - 1);
    }

    const result = await resubmitOrder({
      oldOrderNo: o.kis_order_no,
      ticker: o.ticker,
      orderType: o.order_type,
      quantity: o.quantity,
      newPrice,
    });

    if (result.success) {
      execute(
        `UPDATE auto_trades SET kis_order_no = ?, chase_level = ?, price = ?, error_message = '' WHERE id = ?`,
        [result.orderNo, newLevel, newPrice > 0 ? newPrice : o.price, o.id],
      );
      if (useMarket) marketed++;
      else resubmitted++;
      await logSystemEvent('INFO', 'ORDER_CHASE',
        `미체결 ${o.order_type} 갱신: ${o.ticker} L${newLevel} ${useMarket ? '시장가' : newPrice.toLocaleString()}`,
        `이전 ODNO ${o.kis_order_no} → 신규 ${result.orderNo}`,
        o.ticker,
      );
    } else {
      // 취소 실패 = 이미 체결되었을 가능성 (chase 종료, status는 그대로 두고 다음 fill check에 위임)
      // OR 진짜 실패: 그래도 status=FAILED는 안 하고 로그만
      if (result.message.includes('취소 실패')) {
        // Skip — likely filled
        await logSystemEvent('INFO', 'ORDER_CHASE',
          `chase 스킵 (이미 체결 추정): ${o.ticker}`,
          result.message, o.ticker,
        );
      } else {
        failed++;
        await logSystemEvent('WARN', 'ORDER_CHASE',
          `chase 실패: ${o.ticker}`, result.message, o.ticker,
        );
      }
    }
  }

  return { chased: orders.length, resubmitted, marketed, failed };
}
