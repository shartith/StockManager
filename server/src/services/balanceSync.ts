/**
 * Balance Sync — KIS 잔고 ↔ DB transactions 동기화 (HIGH #7).
 *
 * routes/chart.ts의 /balance/import 핸들러에서 추출한 핵심 로직.
 * dailyStrategy의 EOD reconcile cron에서도 재사용.
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { queryAll, queryOne, execute } from '../db';
import { normalizeMarket } from './marketNormalizer';
import {
  reconcileMarket,
  type KisHoldingSnapshot,
  type SmHoldingRow,
  type SyncResult,
  type ReconcileDeps,
} from './portfolioReconcile';
import logger from '../logger';

export const dbReconcileDeps: ReconcileDeps = {
  getCurrentSmHoldings(markets) {
    const placeholders = markets.map(() => '?').join(',');
    return queryAll<SmHoldingRow>(
      `SELECT s.id as stock_id, s.ticker, s.market,
              COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END), 0) as current_qty
       FROM stocks s
       LEFT JOIN transactions t ON t.stock_id = s.id AND t.deleted_at IS NULL
       WHERE s.market IN (${placeholders}) AND s.deleted_at IS NULL
       GROUP BY s.id
       HAVING current_qty > 0`,
      [...markets],
    );
  },
  findStockId(ticker) {
    const row = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ? AND deleted_at IS NULL', [ticker]);
    return row?.id ?? null;
  },
  insertStock(ticker, name, market) {
    execute(
      'INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)',
      [ticker, name, normalizeMarket(market), ''],
    );
    const row = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
    return row?.id ?? 0;
  },
  insertBuy(stockId, quantity, price, date, memo) {
    execute(
      'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [stockId, 'BUY', quantity, price, 0, date, memo],
    );
  },
  insertSell(stockId, quantity, price, date, memo) {
    execute(
      'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [stockId, 'SELL', quantity, price, 0, date, memo],
    );
  },
  getLastBuyPrice(stockId) {
    const row = queryOne<{ price: number }>(
      "SELECT price FROM transactions WHERE stock_id = ? AND type = 'BUY' AND deleted_at IS NULL ORDER BY date DESC LIMIT 1",
      [stockId],
    );
    return row?.price ?? 0;
  },
};

export interface SyncOutcome {
  ok: boolean;
  message: string;
  result?: SyncResult;
  error?: string;
}

/** KIS 잔고 → DB 동기화 실행. */
export async function syncKisBalance(memo: string = 'KIS 동기화'): Promise<SyncOutcome> {
  const settings = getSettings();
  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret || !settings.kisAccountNo) {
    return { ok: false, message: 'KIS API 설정 또는 계좌번호 없음' };
  }

  try {
    const token = await getAccessToken();
    const trId = settings.kisVirtual ? 'VTTC8434R' : 'TTTC8434R';

    const params = new URLSearchParams({
      CANO: settings.kisAccountNo,
      ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      },
    );

    if (!response.ok) {
      return { ok: false, message: `KIS HTTP ${response.status}`, error: await response.text().catch(() => '') };
    }

    const data = await response.json() as { rt_cd?: string; msg1?: string; output1?: Array<Record<string, string>> };
    if (data.rt_cd !== '0') {
      return { ok: false, message: `KIS API: ${data.msg1}` };
    }

    const today = new Date().toISOString().slice(0, 10);
    const snapshots: KisHoldingSnapshot[] = [];
    for (const item of (data.output1 || [])) {
      const qty = Number(item.hldg_qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      snapshots.push({
        ticker: item.pdno,
        name: item.prdt_name,
        market: 'KRX',
        quantity: qty,
        avgPrice: Math.round(Number(item.pchs_avg_pric)),
      });
    }

    const result = reconcileMarket(snapshots, ['KRX'], 'KRX', today, memo, dbReconcileDeps);
    const totalChanges = result.added.length + result.adjusted.length + result.removed.length;
    const message = totalChanges > 0
      ? `동기화 완료: 신규 ${result.added.length}, 조정 ${result.adjusted.length}, 매도 ${result.removed.length}`
      : '동기화 완료: 변경 없음';

    if (totalChanges > 0) {
      logger.info({ added: result.added.length, adjusted: result.adjusted.length, removed: result.removed.length }, 'syncKisBalance');
    }

    return { ok: true, message, result };
  } catch (err) {
    return { ok: false, message: 'syncKisBalance exception', error: (err as Error).message };
  }
}
