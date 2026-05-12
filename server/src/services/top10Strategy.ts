/**
 * Top 10 Rebalance Strategy.
 *
 * 동작:
 *   1) fetchTop10(true) — 최신 시총 Top 10 (KOSPI+KOSDAQ 통합, 우선주 포함)
 *   2) 보유 중 Top 10 이탈자 → 시장가 매도 (시장 브레이크 무시 — 이탈은 항상)
 *   3) Top 10 신규 진입자 → 균등 분배 시장가 매수 (시장 브레이크 ON이면 매수만 차단)
 *
 * 균등 분배:
 *   - per_stock_budget = floor(가용현금 / 신규 진입 종목 수)
 *   - quantity = floor(budget / closePrice) — 1주 이상
 *   - 1주 가격이 budget 초과면 1주 시도, 1주도 가용현금 초과면 skip
 *
 * 멱등성:
 *   - Top 10 변동이 없으면 매도/매수 모두 0건 (idempotent).
 *   - 매시간 cron 호출에 안전.
 */

import { fetchTop10 } from './topMarketCap';
import { getSettings } from './settings';
import { executeOrder, getDomesticOrderableAmount } from './kisOrder';
import { checkMarketBrake } from './marketBrake';
import { logSystemEvent } from './systemEvent';
import { queryAll, queryOne, execute } from '../db';
import logger from '../logger';

export interface RebalanceTrade {
  ticker: string;
  name: string;
  quantity: number;
  price?: number;
}

export interface RebalanceSkip {
  ticker: string;
  name: string;
  reason: string;
}

export interface RebalanceResult {
  reason: string;              // cron 호출 사유 (e.g., '09:00 daily', '10:00 hourly')
  fetchedAt: string;           // Top 10 데이터 시각
  top10Tickers: string[];
  sold: RebalanceTrade[];
  bought: RebalanceTrade[];
  skipped: RebalanceSkip[];
  brakeReason?: string;        // 시장 브레이크로 매수 차단된 경우
  noop: boolean;               // 매도/매수 모두 0건
}

interface HoldingRow {
  stock_id: number;
  ticker: string;
  name: string;
  qty: number;
}

interface Holding {
  stockId: number;
  ticker: string;
  name: string;
  quantity: number;
}

function getCurrentHoldings(): Holding[] {
  const rows = queryAll<HoldingRow>(`
    SELECT s.id as stock_id, s.ticker, s.name,
           COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END), 0) as qty
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING qty > 0
  `);
  return rows.map((r) => ({
    stockId: r.stock_id,
    ticker: r.ticker,
    name: r.name,
    quantity: Number(r.qty) || 0,
  }));
}

function ensureStockId(ticker: string, name: string, market: 'KOSPI' | 'KOSDAQ'): number {
  const existing = queryOne<{ id: number }>(
    'SELECT id FROM stocks WHERE ticker = ? AND deleted_at IS NULL',
    [ticker],
  );
  if (existing) return existing.id;

  execute(
    'INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)',
    [ticker, name, market, ''],
  );
  const inserted = queryOne<{ id: number }>(
    'SELECT id FROM stocks WHERE ticker = ?',
    [ticker],
  );
  if (!inserted) throw new Error(`stock insert failed: ${ticker}`);
  return inserted.id;
}

/**
 * Top 10 rebalance 1회 실행.
 *
 * @param reason cron / 수동 호출 사유 (로그용)
 */
export async function runTop10Rebalance(reason: string): Promise<RebalanceResult> {
  const settings = getSettings();
  const fetched = await fetchTop10(true);
  const top10 = fetched.top10;
  const top10Tickers = top10.map((s) => s.ticker);

  const result: RebalanceResult = {
    reason,
    fetchedAt: fetched.fetchedAt,
    top10Tickers,
    sold: [],
    bought: [],
    skipped: [],
    noop: true,
  };

  if (!settings.autoTradeEnabled) {
    logger.info({ reason, top10Tickers }, '[Top10] autoTradeEnabled=false — dry-run');
    return result;
  }

  const holdings = getCurrentHoldings();
  const top10Set = new Set(top10Tickers);

  // 1. 매도 — 보유 중 Top 10 이탈자 (시장 브레이크 무시: 이탈 매도는 항상)
  for (const h of holdings) {
    if (top10Set.has(h.ticker)) continue;
    try {
      const r = await executeOrder({
        stockId: h.stockId,
        ticker: h.ticker,
        market: 'KRX',
        orderType: 'SELL',
        quantity: h.quantity,
        price: 0,
        reason: 'Top10 이탈 — 시총 10위 밖',
      });
      if (r.success) {
        result.sold.push({ ticker: h.ticker, name: h.name, quantity: h.quantity });
        logger.info({ ticker: h.ticker, qty: h.quantity }, '[Top10] SELL 체결');
      } else {
        result.skipped.push({ ticker: h.ticker, name: h.name, reason: `SELL 실패: ${r.message}` });
      }
    } catch (err) {
      result.skipped.push({
        ticker: h.ticker,
        name: h.name,
        reason: `SELL 예외: ${(err as Error).message}`,
      });
    }
  }

  // 2. 매수 — Top 10 신규 진입자 (보유에 없는 것)
  const heldTickers = new Set(holdings.map((h) => h.ticker));
  const newEntries = top10.filter((s) => !heldTickers.has(s.ticker));

  if (newEntries.length > 0) {
    const brake = await checkMarketBrake();
    if (brake.shouldBrake) {
      result.brakeReason = brake.reason;
      logger.info(
        { reason: brake.reason, candidates: newEntries.length },
        '[Top10] 시장 브레이크 — 신규 매수 차단',
      );
    } else {
      const cashAmount = await getDomesticOrderableAmount().catch(() => 0);
      if (cashAmount <= 0) {
        for (const s of newEntries) {
          result.skipped.push({
            ticker: s.ticker,
            name: s.name,
            reason: '주문가능금액 0',
          });
        }
      } else {
        const perStockBudget = Math.floor(cashAmount / newEntries.length);

        for (const s of newEntries) {
          if (s.closePrice <= 0) {
            result.skipped.push({ ticker: s.ticker, name: s.name, reason: '가격 정보 없음' });
            continue;
          }

          let quantity = Math.floor(perStockBudget / s.closePrice);
          if (quantity === 0) {
            if (s.closePrice > cashAmount) {
              result.skipped.push({
                ticker: s.ticker,
                name: s.name,
                reason: `1주(${s.closePrice.toLocaleString()}원) > 가용현금(${cashAmount.toLocaleString()}원)`,
              });
              continue;
            }
            quantity = 1;
          }

          try {
            const stockId = ensureStockId(s.ticker, s.name, s.market);
            const r = await executeOrder({
              stockId,
              ticker: s.ticker,
              market: 'KRX',
              orderType: 'BUY',
              quantity,
              price: 0,
              reason: `Top10 #${s.rank} 신규 진입 (${s.marketCapHangeul})`,
            });
            if (r.success) {
              result.bought.push({
                ticker: s.ticker,
                name: s.name,
                quantity,
                price: r.price,
              });
              logger.info(
                { ticker: s.ticker, qty: quantity, price: r.price },
                '[Top10] BUY 체결',
              );
            } else {
              result.skipped.push({
                ticker: s.ticker,
                name: s.name,
                reason: `BUY 실패: ${r.message}`,
              });
            }
          } catch (err) {
            result.skipped.push({
              ticker: s.ticker,
              name: s.name,
              reason: `BUY 예외: ${(err as Error).message}`,
            });
          }
        }
      }
    }
  }

  result.noop = result.sold.length === 0 && result.bought.length === 0;

  if (!result.noop) {
    await logSystemEvent(
      'INFO',
      'GENERAL',
      `[Top10] rebalance — 매도 ${result.sold.length}건, 매수 ${result.bought.length}건 (${reason})`,
      JSON.stringify({
        reason,
        sold: result.sold,
        bought: result.bought,
        skipped: result.skipped,
        brakeReason: result.brakeReason,
      }),
      '',
    );
  } else {
    logger.debug({ reason }, '[Top10] noop — Top 10 변동 없음');
  }

  return result;
}
