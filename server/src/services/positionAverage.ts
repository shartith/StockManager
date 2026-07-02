/**
 * 포지션 평단가 계산 — KIS(증권사) 방식의 이동평균 (v6.0.4).
 *
 * 배경(운영 버그): 기존 계산은 `SUM(모든 BUY 금액) / SUM(모든 BUY 수량)` 으로
 * **이미 매도해 사라진 과거 매수까지 전부 평균** → 삼성전자 실제 매입평균 309,500원이
 * 앱에서는 277,250원으로 표시(5월에 263,000원대에 사고팔았던 8주가 섞임).
 *
 * KIS(및 모든 증권사)의 매입평균 규칙:
 *   - BUY  : avg = (보유qty×avg + 매수qty×price) / (보유qty + 매수qty)
 *   - SELL : 수량만 감소, avg 는 그대로 (매도는 평단을 바꾸지 않음)
 *   - 전량 매도(qty=0) : 포지션 종료 → 다음 매수부터 avg 새로 시작
 *
 * 이 모듈이 단일 계산처 — calculator(화면 표시)와 rebalanceStrategy(매매 판정:
 * 트레일링 활성/손실바닥)가 모두 이걸 쓴다. 평단이 틀리면 수익률이 틀리고,
 * 수익률이 틀리면 매매 판정이 틀리기 때문에 화면 문제이자 엔진 문제다.
 */

import { queryAll } from '../db';

export interface PositionTx {
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
}

export interface PositionState {
  quantity: number;
  avgPrice: number;
}

/**
 * 거래 내역(시간순)을 KIS 방식으로 접어 현재 포지션(수량/평단)을 계산.
 * 순수 함수 — 단위 테스트 대상.
 *
 * 데이터 드리프트 방어: 보유량보다 많은 SELL 이 오면 0 으로 클램프하고 포지션 리셋
 * (동기화 어긋난 DB 에서 음수 수량/엉뚱한 평단이 생기지 않도록).
 */
export function foldPositionAverage(txs: readonly PositionTx[]): PositionState {
  let quantity = 0;
  let avgPrice = 0;

  for (const tx of txs) {
    if (tx.type === 'BUY') {
      const newQty = quantity + tx.quantity;
      avgPrice = newQty > 0 ? (quantity * avgPrice + tx.quantity * tx.price) / newQty : 0;
      quantity = newQty;
    } else {
      quantity -= tx.quantity;
      if (quantity <= 0) {
        quantity = 0;
        avgPrice = 0; // 전량 매도 → 포지션 종료, 평단 리셋
      }
      // 부분 매도는 avgPrice 유지 (KIS 와 동일)
    }
  }

  return { quantity, avgPrice };
}

interface TxRow {
  stock_id: number;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
}

/**
 * 단일 종목의 현재 포지션(수량/평단) — fold 방식 (엔진과 동일 계산).
 *
 * reconcile(balanceSync)이 잔고 차이를 판정할 때 이 함수를 쓴다. 과거에는
 * reconcile 이 raw SUM(BUY-SELL) 으로 계산해 엔진(fold/클램프)과 다른 값을 봤고,
 * 그 차이가 "추가매수 동기화" 유령 매수로 굳어져 매도 주문 수량이 부풀었다
 * (삼성전자 SELL 9주 vs 실잔고 4주 → APBK0400 120여 회 반복 사건).
 */
export function getPositionQuantity(stockId: number): number {
  const txs = queryAll<PositionTx>(
    `SELECT t.type, t.quantity, t.price
     FROM transactions t
     WHERE t.stock_id = ? AND t.deleted_at IS NULL
     ORDER BY t.date, t.id`,
    [stockId],
  );
  return foldPositionAverage(txs).quantity;
}

/**
 * 전 종목의 현재 포지션(수량/평단)을 stock_id 별로 계산.
 * 거래를 (date, id) 순으로 접으므로 같은 날 여러 체결도 입력 순서대로 반영.
 */
export function getPositionAverages(): Map<number, PositionState> {
  const rows = queryAll<TxRow>(`
    SELECT t.stock_id, t.type, t.quantity, t.price
    FROM transactions t
    JOIN stocks s ON s.id = t.stock_id
    WHERE t.deleted_at IS NULL AND s.deleted_at IS NULL
    ORDER BY t.stock_id, t.date, t.id
  `);

  const byStock = new Map<number, PositionTx[]>();
  for (const r of rows) {
    const arr = byStock.get(r.stock_id);
    const tx: PositionTx = { type: r.type, quantity: r.quantity, price: r.price };
    if (arr) arr.push(tx);
    else byStock.set(r.stock_id, [tx]);
  }

  const result = new Map<number, PositionState>();
  for (const [stockId, txs] of byStock) {
    result.set(stockId, foldPositionAverage(txs));
  }
  return result;
}
