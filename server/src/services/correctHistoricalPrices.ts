/**
 * 기존에 잘못된 평단으로 입력된 transactions 를 KIS 거래내역의 실제 체결가로 보정.
 *
 * 대상: memo 안에 "KIS 동기화" 가 있으나 "odno=" 가 없는 거래
 *      (v5.6.2 이전 reconcile 이 avg_price 로 박은 행).
 *
 * 매칭 규칙: ticker + type + quantity 가 일치하는 KIS 체결을 찾되,
 *   - 후보가 0개 → 보정 불가 (skip)
 *   - 후보가 1개 → 그 가격으로 보정
 *   - 후보가 2개 이상 → 날짜가 가장 가까운 것으로 보정
 *
 * 안전장치: dryRun 기본. 적용 시 memo 끝에 ' [price-fix yyyy-mm-dd]' + ' odno=...' 추가.
 */

import { queryAll, execute } from '../db';
import { fetchKisTradeHistory } from './kisTradeHistory';
import type { KisTrade } from './portfolioReconcile';
import logger from '../logger';

export interface CorrectionPlan {
  txId: number;
  ticker: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  oldPrice: number;
  newPrice: number;
  oldDate: string;
  matchedOdno: string;
  matchedDate: string;
  delta: number;          // newPrice - oldPrice
}

export interface CorrectionResult {
  scanned: number;        // 검사한 후보 transactions 수
  candidates: number;     // 보정 가능한 transactions 수 (= corrections.length)
  applied: number;        // 실제 update 된 수 (dryRun=true 면 0)
  unmatched: number;      // KIS 거래내역에서 매치를 못 찾은 수
  corrections: CorrectionPlan[];
  unmatchedItems: { txId: number; ticker: string; quantity: number; type: 'BUY' | 'SELL'; price: number; date: string }[];
}

interface OldSyncTx {
  id: number;
  ticker: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  date: string;
  memo: string;
}

/**
 * 한 거래에 가장 맞는 KIS 체결을 고른다. 후보 우선순위:
 *   1) ticker + type + quantity 정확히 일치
 *   2) 그중 날짜가 가장 가까운 것
 */
function pickBestMatch(tx: OldSyncTx, trades: KisTrade[], usedOdnos: Set<string>): KisTrade | null {
  const candidates = trades.filter(
    t => t.ticker === tx.ticker && t.type === tx.type && t.quantity === tx.quantity && !usedOdnos.has(t.odno),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const txDate = new Date(tx.date).getTime();
  let best = candidates[0];
  let bestDist = Math.abs(new Date(best.date).getTime() - txDate);
  for (const c of candidates.slice(1)) {
    const dist = Math.abs(new Date(c.date).getTime() - txDate);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

export async function correctHistoricalPrices(dryRun: boolean): Promise<CorrectionResult> {
  // 1) KIS 거래내역 90 일치
  const trades = await fetchKisTradeHistory(90);

  // 2) 보정 후보: "KIS 동기화" memo & odno= 없는 행
  //    NOT LIKE '%odno=%' 로 신/구 동기화 결과를 정확히 가른다.
  const targets = queryAll<OldSyncTx>(
    `SELECT t.id, s.ticker, t.type, t.quantity, t.price, t.date, t.memo
     FROM transactions t JOIN stocks s ON s.id = t.stock_id
     WHERE t.deleted_at IS NULL
       AND t.memo LIKE '%KIS 동기화%'
       AND t.memo NOT LIKE '%odno=%'
     ORDER BY t.date ASC, t.id ASC`,
  );

  const corrections: CorrectionPlan[] = [];
  const unmatchedItems: CorrectionResult['unmatchedItems'] = [];
  const usedOdnos = new Set<string>();

  for (const tx of targets) {
    const match = pickBestMatch(tx, trades, usedOdnos);
    if (!match) {
      unmatchedItems.push({
        txId: tx.id,
        ticker: tx.ticker,
        quantity: tx.quantity,
        type: tx.type,
        price: tx.price,
        date: tx.date,
      });
      continue;
    }
    usedOdnos.add(match.odno);
    if (match.price === tx.price) continue; // 이미 같은 가격이면 skip
    corrections.push({
      txId: tx.id,
      ticker: tx.ticker,
      type: tx.type,
      quantity: tx.quantity,
      oldPrice: tx.price,
      newPrice: match.price,
      oldDate: tx.date,
      matchedOdno: match.odno,
      matchedDate: match.date,
      delta: match.price - tx.price,
    });
  }

  let applied = 0;
  if (!dryRun && corrections.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    for (const c of corrections) {
      execute(
        `UPDATE transactions
         SET price = ?, memo = memo || ?
         WHERE id = ? AND deleted_at IS NULL`,
        [c.newPrice, ` [price-fix ${today} odno=${c.matchedOdno}]`, c.txId],
      );
      applied += 1;
    }
    logger.info({ applied, total: corrections.length }, 'correctHistoricalPrices applied');
  }

  return {
    scanned: targets.length,
    candidates: corrections.length,
    applied,
    unmatched: unmatchedItems.length,
    corrections,
    unmatchedItems,
  };
}
