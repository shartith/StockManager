/**
 * Balance Sync — KIS 잔고 ↔ DB transactions 동기화 (HIGH #7).
 *
 * routes/chart.ts의 /balance/import 핸들러에서 추출한 핵심 로직.
 * dailyStrategy의 EOD reconcile cron에서도 재사용.
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings, saveSettings } from './settings';
import { getKisBalance } from './kisBalance';
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
    //
    // 기준일(ledgerBaselineDate) 이전 체결은 제외 — resetLedgerToCurrentHoldings()
    // 로 원장을 초기화하면 그 시점 이전 거래는 모두 삭제되고 기준 잔고 1건으로
    // 대체된다. 필터 없이 그대로 두면 이 함수가 "삭제된 거래 = 아직 안 들어온
    // 거래"로 오인해 매번 재삽입 → 초기화해도 계속 되살아나는 문제가 생긴다.
    const tradeHistory = await fetchKisTradeHistory(90);
    const filteredHistory = settings.ledgerBaselineDate
      ? tradeHistory.filter((t) => t.date > settings.ledgerBaselineDate)
      : tradeHistory;
    const tradesByTicker = indexTradesByTicker(filteredHistory);
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

export interface LedgerResetSeed {
  ticker: string;
  name: string;
  quantity: number;
  avgPrice: number;
}

export interface LedgerResetOutcome {
  ok: boolean;
  dryRun: boolean;
  message: string;
  deletedCount?: number;
  seeded?: LedgerResetSeed[];
}

/**
 * 거래내역 초기화 — 기존 거래를 전량 삭제하고 KIS 실잔고 스냅샷 1건으로 재시딩한다.
 *
 * 배경: 삭제한 거래가 반복적으로 되살아나는 문제 — DELETE(routes/transactions.ts)는
 * soft-delete(deleted_at)인데, syncKisBalance 가 90일 KIS 체결내역과 원장을 odno 로
 * 대조할 때 deleted_at IS NULL 인 행만 "이미 있음"으로 치므로, 삭제된 행은 매번
 * "누락된 거래"로 재판정되어 다시 삽입된다. 개별 행 삭제로는 이 되살아남을 막을 수 없다.
 *
 * 해결: 원장을 통째로 비우고 오늘 날짜로 "기준 잔고" 1건(종목당 BUY 1건, 실제
 * 보유수량·KIS 매입평균)만 남긴 뒤, 그 날짜를 ledgerBaselineDate 로 저장한다.
 * 이후 syncKisBalance 는 기준일 이전 체결을 전부 무시하므로 되살아나지 않는다.
 * 기준일 이후의 실제 거래(자동매매/수동주문)는 평소대로 정상 기록된다.
 *
 * dryRun=true(기본): 삭제/시딩 없이 무엇이 바뀔지만 미리보기로 반환한다.
 */
export async function resetLedgerToCurrentHoldings(
  memo: string = '거래내역 초기화',
  dryRun: boolean = true,
): Promise<LedgerResetOutcome> {
  const settings = getSettings();
  const { appKey, appSecret } = getKisConfig();
  if (!appKey || !appSecret || !settings.kisAccountNo) {
    return { ok: false, dryRun, message: 'KIS API 설정 또는 계좌번호 없음' };
  }

  const balance = await getKisBalance(true);
  if (!balance) {
    return { ok: false, dryRun, message: 'KIS 잔고 조회 실패 — 초기화를 취소했습니다.' };
  }

  const seeded: LedgerResetSeed[] = balance.holdings
    .filter((h) => h.quantity > 0)
    .map((h) => ({ ticker: h.ticker, name: h.name, quantity: h.quantity, avgPrice: h.avgPrice }));

  const activeCount = queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM transactions WHERE deleted_at IS NULL',
  )?.n ?? 0;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      message: `미리보기: 기존 거래 ${activeCount}건 삭제 + 보유 ${seeded.length}종목을 기준 잔고로 재시딩합니다.`,
      deletedCount: activeCount,
      seeded,
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  execute("UPDATE transactions SET deleted_at = datetime('now') WHERE deleted_at IS NULL");

  for (const h of seeded) {
    let stockId = dbReconcileDeps.findStockId(h.ticker);
    if (stockId === null) {
      stockId = dbReconcileDeps.insertStock(h.ticker, h.name, 'KRX');
    }
    dbReconcileDeps.insertBuy(stockId, h.quantity, h.avgPrice, today, `${memo} (기준일 재설정)`);
  }

  saveSettings({ ledgerBaselineDate: today });

  logger.info({ deletedCount: activeCount, seeded: seeded.length }, 'resetLedgerToCurrentHoldings');

  return {
    ok: true,
    dryRun: false,
    message: `초기화 완료: 기존 거래 ${activeCount}건 삭제, 보유 ${seeded.length}종목을 기준 잔고로 재시딩 (기준일 ${today})`,
    deletedCount: activeCount,
    seeded,
  };
}
