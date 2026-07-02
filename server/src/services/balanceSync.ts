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
  type KisTrade,
} from './portfolioReconcile';
import { fetchKisTradeHistory, indexTradesByTicker } from './kisTradeHistory';
import { getPositionAverages, getPositionQuantity } from './positionAverage';
import { kisFetchJson } from './kisHttp';
import logger from '../logger';

export const dbReconcileDeps: ReconcileDeps = {
  // 시장 필터 없이 보유분 전체를 조회한다 (KRX 단일 시장 앱).
  // 같은 종목이 'KRX'/'KOSPI'/'KOSDAQ'/'' 등 제각각 market 값으로 저장될 수 있어
  // (insert 경로별 정규화 불일치) market 으로 거르면 findStockId(시장 무시)와 어긋나
  // 보유분이 0 으로 오인된다 → 가져오기/EOD reconcile 마다 phantom BUY 가 누적된다.
  // findStockId 와 동일하게 시장을 무시해 멱등성을 보장한다.
  //
  // 수량은 raw SUM(BUY-SELL) 이 아니라 매매 엔진(positionAverage)과 동일한
  // fold(초과매도 0 클램프) 방식으로 계산한다. 두 계산이 다르면 그 차이만큼
  // "추가매수 동기화" 유령 매수가 굳어져 매도 주문 수량이 부풀고, KIS 가
  // APBK0400 으로 전량 거부해 포지션이 못 팔린 채 방치된다 (삼성전자 사건).
  getCurrentSmHoldings() {
    const positions = getPositionAverages();
    const stocks = queryAll<{ stock_id: number; ticker: string; market: string }>(
      `SELECT id as stock_id, ticker, COALESCE(market, 'KRX') as market
       FROM stocks WHERE deleted_at IS NULL`,
    );
    return stocks
      .map((s): SmHoldingRow => ({
        ...s,
        current_qty: positions.get(s.stock_id)?.quantity ?? 0,
      }))
      .filter((s) => s.current_qty > 0);
  },
  recomputeQty(stockId) {
    return getPositionQuantity(stockId);
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
  hasTradeOdno(stockId, odno) {
    // 두 가지 memo 포맷에 모두 KIS 주문번호가 들어간다 — 양쪽 다 매칭해야
    // EOD reconcile 이 자동매매 transaction 을 중복 입력하지 않는다.
    //   - 신규 sync:    "KIS 동기화 (체결) odno=12345"
    //   - 자동매매:     "자동매매 (KIS: 12345)" 또는 "... (KIS: 12345) / reason"
    // odno 는 KIS 발급 숫자 문자열이라 LIKE 인젝션 위험 없음.
    const row = queryOne<{ n: number }>(
      `SELECT COUNT(*) as n FROM transactions
       WHERE stock_id = ? AND deleted_at IS NULL
         AND (memo LIKE ? OR memo LIKE ?)`,
      [stockId, `%odno=${odno}%`, `%KIS: ${odno})%`],
    );
    return (row?.n ?? 0) > 0;
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

    const { ok, status, data, rateLimited } = await kisFetchJson<{ rt_cd?: string; msg1?: string; output1?: Array<Record<string, string>> }>(
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
      'balanceSync-inquire-balance',
    );

    if (!ok || !data) {
      return {
        ok: false,
        message: rateLimited ? 'KIS 호출 한도 초과 (재시도 후 실패)' : `KIS API: ${data?.msg1 ?? `HTTP ${status}`}`,
      };
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

    // 거래내역 90일치 선조회 → ticker 별 캐싱. reconcile 이 종목별로 동기적으로
    // fetchKisTrades 를 호출할 때 메모리에서 즉시 응답한다. 네트워크는 1회만.
    const tradeHistory = await fetchKisTradeHistory(90);
    const tradesByTicker = indexTradesByTicker(tradeHistory);
    const depsWithTrades: ReconcileDeps = {
      ...dbReconcileDeps,
      fetchKisTrades(ticker: string): KisTrade[] {
        return tradesByTicker.get(ticker) ?? [];
      },
    };

    const result = reconcileMarket(snapshots, ['KRX'], 'KRX', today, memo, depsWithTrades);
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
