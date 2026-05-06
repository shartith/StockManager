/**
 * Daily Strategy — v5.1.0 강화된 12-Rule 매매 엔진.
 *
 * 매수 (Rule 1~5):
 *   1, 2: 08:50 buildAutoList (섹터 로테이션 → 카테고리 → 갭상승 제외 상위 종목)
 *   3:    09:05~09:55 5분 간격 매수창
 *   4:    보유금액 ÷ N종목 (±5%) 동적 종목당 한도
 *   5:    시초가(09:00 open) 대비 +1% 이상 상승 + 거래량 검증 + 호가 품질 OK + VI 미발동
 *
 * 매도 (Rule 6~9): sellRules.ts에 위임
 *   - 트레일링은 +3% 도달 후 sticky 활성
 *   - 정체(STAGNANT_TIME): +3% 미달 + 1시간 → 매도
 *   - 손실 시간초과(LOSS_TIME): 손실 + 1시간 → 강제 손절
 *
 * EOD (Rule 10, 11):
 *   10: 15:00 +3% 이상 보유분 익절
 *   11: 15:20 당일 매수분 강제 정리 (동시호가 직전)
 *   추가: 15:50 KIS balance reconcile + 일일 리포트
 *
 * 추가 보강 (v5.1):
 *   - 시장 브레이크: KOSPI -2% 이하면 신규 매수 차단
 *   - 동일 섹터 집중 제한: 최대 2종목
 *   - 재진입 cooldown: 매도 후 30분 매수 차단
 *   - 호가 품질 게이트: 매수 직전 quoteBook 체크 (POOR 차단)
 *   - 거래량 검증: 5일 평균 대비 ≥ 0.8
 *   - In-memory state 영구화: intradayState (DB-backed)
 *   - Reserved orders 트리거 평가
 */

import { queryAll, queryOne, execute } from '../db';
import { getSettings } from './settings';
import { getKisStockSnapshot, fetchYahooQuote } from './stockPrice';
import { getAccessToken } from './kisAuth';
import { listActive as listActiveTargets } from './watchTargets';
import {
  listActive as listActiveReserved,
  isTriggered,
  markExecuted,
  recordExecutionAttempt,
  expireStale as expireStaleReserved,
} from './reservedOrders';
import { evaluateSellRules, resetPeakPrice, getBuyTimestamp } from './sellRules';
import {
  setOpeningPriceIfMissing,
  markBought,
  markSold,
  isInCooldown,
  isBoughtToday,
  syncTodayFromTransactions,
  getState,
} from './intradayState';
import { checkMarketBrake } from './marketBrake';
import { getQuoteBook } from './quoteBook';
import { executeOrder, getDomesticOrderableAmount } from './kisOrder';
import { logSystemEvent } from './systemEvent';
import logger from '../logger';

// ── 상수 (settings 미노출) ──

const SAME_SECTOR_MAX = 2;        // 동일 섹터 최대 보유 (HIGH #9)
const MIN_VOLUME_RATIO = 0.8;     // 5일 평균 대비 거래량 비율 (HIGH #4)
const POSITION_TOLERANCE = 0.05;  // ±5% (사용자 안)

// ── Daily 시작 ──

export function resetDailyState(): void {
  // intradayState는 DB-backed이므로 별도 메모리 reset 불필요.
  // 단, 오늘 transactions에 BUY가 이미 있는 종목들의 boughtToday 동기화.
  syncTodayFromTransactions();
  logger.info({ date: new Date().toISOString().slice(0, 10) }, 'dailyStrategy daily reset');
}

// ── 보유 정보 ──

interface HoldingInfo {
  stockId: number;
  ticker: string;
  market: string;
  sector: string;
  quantity: number;
  avgPrice: number;
  isFromToday: boolean;
}

function getHoldings(): HoldingInfo[] {
  const rows = queryAll<{
    stock_id: number; ticker: string; market: string; sector: string;
    qty: number; avg_price: number;
  }>(`
    SELECT s.id as stock_id, s.ticker, COALESCE(s.market, 'KRX') as market,
           COALESCE(s.sector, '') as sector,
           SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE -t.quantity END) as qty,
           CASE WHEN SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END) > 0
             THEN SUM(CASE WHEN t.type='BUY' THEN t.quantity * t.price ELSE 0 END)
                / SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END)
             ELSE 0 END as avg_price
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING qty > 0
  `);
  return rows.map(r => ({
    stockId: r.stock_id,
    ticker: r.ticker,
    market: r.market,
    sector: r.sector,
    quantity: r.qty,
    avgPrice: r.avg_price,
    isFromToday: isBoughtToday(r.stock_id),
  }));
}

// ── 거래량 검증 (HIGH #4) ──

interface VolumeStat {
  todayVolume: number;
  avg5dVolume: number;
  ratio: number;
}

/**
 * 5일 평균 거래량 대비 오늘 누적 거래량 비율.
 * KIS daily candle (5일) 가져와서 평균 계산.
 */
async function getVolumeRatio(ticker: string, todayVolume: number): Promise<number> {
  try {
    const { getKisConfig } = await import('./kisAuth');
    const { appKey, appSecret, baseUrl } = getKisConfig();
    if (!appKey || !appSecret) return 1; // 설정 없으면 통과

    const token = await getAccessToken();
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 10); // 5 영업일 + 여유
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');

    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
      fid_input_date_1: start,
      fid_input_date_2: end,
      fid_period_div_code: 'D',
      fid_org_adj_prc: '0',
    });
    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey, appsecret: appSecret,
          tr_id: 'FHKST03010100', custtype: 'P',
        },
      },
    );
    if (!response.ok) return 1;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return 1;

    // output2: 일자별, 오늘 제외한 직전 5일 평균
    const daily = (data.output2 || [])
      .filter((d: any) => d.stck_bsop_date && Number(d.acml_vol) > 0)
      .map((d: any) => Number(d.acml_vol));
    // 첫 번째가 가장 최근 (오늘 또는 직전 영업일). 오늘 제외 5일 평균.
    const recent5 = daily.slice(1, 6);
    if (recent5.length < 3) return 1;
    const avg = recent5.reduce((a: number, b: number) => a + b, 0) / recent5.length;
    return avg > 0 ? todayVolume / avg : 1;
  } catch {
    return 1;
  }
}

// ── 매수 평가 (Rule 4, 5) ──

async function evaluateBuyForTarget(
  target: ReturnType<typeof listActiveTargets>[number],
  perStockBudget: number,
  currentHoldings: HoldingInfo[],
  token: string,
): Promise<{ bought: boolean; reason: string }> {
  const settings = getSettings();
  const entryGain = settings.entryGainPercent ?? 1.0;
  const cooldownMin = settings.reEntryCooldownMinutes ?? 30;

  // 1. 이미 보유 중이면 스킵
  const existingHolding = currentHoldings.find(h => h.stockId === target.stockId);
  if (existingHolding) {
    return { bought: false, reason: 'already holding' };
  }

  // 2. 오늘 이미 한 번 매수했으면 스킵 (재매수 방지)
  if (isBoughtToday(target.stockId)) {
    return { bought: false, reason: 'already bought today' };
  }

  // 3. 재진입 cooldown (HIGH #11)
  if (isInCooldown(target.stockId, cooldownMin)) {
    return { bought: false, reason: `cooldown ${cooldownMin}분 미경과` };
  }

  // 4. 동일 섹터 집중도 (HIGH #9)
  if (target.sector) {
    const sameSectorCount = currentHoldings.filter(h => h.sector === target.sector).length;
    if (sameSectorCount >= SAME_SECTOR_MAX) {
      return { bought: false, reason: `섹터 ${target.sector} 이미 ${sameSectorCount}종목` };
    }
  }

  // 5. KIS snapshot — 가격 + 거래량 + VI + 시초가 1회 조회
  const snap = await getKisStockSnapshot(target.ticker, token);
  if (!snap || snap.price <= 0) {
    return { bought: false, reason: 'KIS 시세 조회 실패' };
  }

  // 6. VI 발동 종목 차단 (LOW #15)
  if (snap.viActivated) {
    return { bought: false, reason: 'VI 발동 종목' };
  }

  // 7. 시초가 baseline 기록 (HIGH #2)
  setOpeningPriceIfMissing(target.stockId, snap.open > 0 ? snap.open : snap.price);
  const state = getState(target.stockId);
  const opening = state?.openingPrice ?? snap.open ?? snap.price;
  if (opening <= 0) {
    return { bought: false, reason: 'opening price unavailable' };
  }

  // 8. Rule 5: 시초가 대비 +1% 이상 상승
  const gainFromOpen = ((snap.price - opening) / opening) * 100;
  if (gainFromOpen < entryGain) {
    return { bought: false, reason: `gainFromOpen ${gainFromOpen.toFixed(2)}% < ${entryGain}%` };
  }

  // 9. 거래량 검증 (HIGH #4)
  const volRatio = await getVolumeRatio(target.ticker, snap.volume);
  if (volRatio < MIN_VOLUME_RATIO) {
    return { bought: false, reason: `거래량 부족 (${volRatio.toFixed(2)}x < ${MIN_VOLUME_RATIO}x)` };
  }

  // 10. 호가 품질 게이트 (HIGH #5)
  try {
    const qb = await getQuoteBook(target.ticker, 'KRX');
    if (qb && qb.quality === 'POOR') {
      return { bought: false, reason: `호가 품질 POOR (스프레드 ${qb.spreadPercent.toFixed(2)}%)` };
    }
  } catch {}

  // 11. Rule 4: 동적 종목당 한도 (사용자 안: ±5% 허용)
  if (snap.price > perStockBudget * (1 + POSITION_TOLERANCE)) {
    return { bought: false, reason: `주가 ${snap.price} > 한도 상한 ${Math.round(perStockBudget * 1.05)}` };
  }
  // 수량 = floor(perStockBudget / price)
  const quantity = Math.max(1, Math.floor(perStockBudget / snap.price));
  if (quantity < 1) {
    return { bought: false, reason: 'quantity < 1' };
  }
  // 실제 매수 금액이 한도 ±5% 이내인지 검증
  const amount = quantity * snap.price;
  if (amount < perStockBudget * (1 - POSITION_TOLERANCE)) {
    // 예: 비싼 종목이라 1주 가격이 한도의 95% 미만이면 너무 적게 사는 것 → 그대로 진행
    // (1주만 사는 게 맞음. 추가 종목은 다른 종목으로 분산)
  }

  // 12. KIS 주문 실행
  try {
    const result = await executeOrder({
      stockId: target.stockId,
      ticker: target.ticker,
      market: 'KRX',
      orderType: 'BUY',
      quantity,
      price: 0, // 시장가 (executeOrder 내부에서 -0.5% 지정가 변환)
      reason: `시초가+${gainFromOpen.toFixed(1)}% 진입 (vol×${volRatio.toFixed(1)})`,
    });
    if (result.success) {
      markBought(target.stockId, result.price);
      await logSystemEvent('INFO', 'AUTO_BUY',
        `자동매수: ${target.ticker} ${result.quantity}주 @ ${result.price.toLocaleString()}`,
        `시초가 ${opening} → 현재 ${snap.price} (+${gainFromOpen.toFixed(2)}%) | vol ${volRatio.toFixed(2)}x | ${target.reason}`,
        target.ticker,
      );
      return { bought: true, reason: `bought ${result.quantity} @ ${result.price}` };
    }
    return { bought: false, reason: `order failed: ${result.message}` };
  } catch (err) {
    return { bought: false, reason: `exception: ${(err as Error).message}` };
  }
}

// ── 매도 평가 (Rule 6, 7, 8, 9) ──

async function evaluateSellForHolding(holding: HoldingInfo, token: string): Promise<{ sold: boolean; rule?: string }> {
  const snap = await getKisStockSnapshot(holding.ticker, token);
  const currentPrice = snap?.price ?? 0;
  if (currentPrice <= 0) return { sold: false };

  const unrealizedPnLPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

  const result = evaluateSellRules({
    stockId: holding.stockId,
    ticker: holding.ticker,
    currentPrice,
    avgPrice: holding.avgPrice,
    quantity: holding.quantity,
    unrealizedPnLPercent,
  });

  if (!result.shouldSell) return { sold: false };

  try {
    const sellResult = await executeOrder({
      stockId: holding.stockId,
      ticker: holding.ticker,
      market: 'KRX',
      orderType: 'SELL',
      quantity: holding.quantity,
      price: 0,
      reason: result.rule ?? '',
    });
    if (sellResult.success) {
      resetPeakPrice(holding.stockId);
      markSold(holding.stockId);
      await logSystemEvent('INFO', 'AUTO_SELL',
        `자동매도(${result.rule}): ${holding.ticker} ${sellResult.quantity}주 @ ${sellResult.price.toLocaleString()}`,
        result.reason ?? '',
        holding.ticker,
      );
      return { sold: true, rule: result.rule };
    }
  } catch (err) {
    logger.error({ err, ticker: holding.ticker }, 'sell order exception');
  }
  return { sold: false };
}

// ── Reserved Orders 트리거 ──

async function evaluateReservedOrders(token: string): Promise<number> {
  const orders = listActiveReserved();
  if (orders.length === 0) return 0;

  let executed = 0;
  for (const order of orders) {
    const snap = await getKisStockSnapshot(order.ticker, token);
    const currentPrice = snap?.price ?? 0;
    if (currentPrice <= 0) continue;
    if (!isTriggered(order, currentPrice)) continue;

    let qty = order.quantity;
    if (order.orderType === 'BUY' && qty <= 0) {
      // 보유금액 기반 자동 산정
      const settings = getSettings();
      const total = settings.autoTradeMaxInvestment;
      const positions = settings.positionMaxPositions;
      const perStockBudget = total / Math.max(positions, 1);
      qty = Math.max(1, Math.floor(perStockBudget / currentPrice));
    }
    if (qty <= 0) {
      recordExecutionAttempt(order.id, '수량 산정 불가');
      continue;
    }

    try {
      const result = await executeOrder({
        stockId: order.stockId,
        ticker: order.ticker,
        market: 'KRX',
        orderType: order.orderType,
        quantity: qty,
        price: order.targetPrice, // 지정가
        reason: `예약주문 (${order.condition} ${order.targetPrice})`,
      });
      if (result.success) {
        markExecuted(order.id);
        if (order.orderType === 'BUY') markBought(order.stockId, result.price);
        else { resetPeakPrice(order.stockId); markSold(order.stockId); }
        await logSystemEvent('INFO', 'RESERVED_EXEC',
          `예약 ${order.orderType === 'BUY' ? '매수' : '매도'} 체결: ${order.ticker} ${result.quantity}주`,
          `target=${order.targetPrice}, current=${currentPrice}, reason=${order.reason}`,
          order.ticker,
        );
        executed++;
      } else {
        recordExecutionAttempt(order.id, `주문 실패: ${result.message}`);
      }
    } catch (err) {
      recordExecutionAttempt(order.id, `예외: ${(err as Error).message}`);
    }
  }
  return executed;
}

// ── 5분 tick ──

/**
 * 09:05~09:55 매수창 + 10:00~14:55 모니터링.
 * 매수 윈도우 외에도 매도/예약 평가는 항상 실행.
 */
export async function runFiveMinTick(): Promise<{
  evaluated: number;
  bought: number;
  sold: number;
  reservedExecuted: number;
  brakeReason?: string;
}> {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    return { evaluated: 0, bought: 0, sold: 0, reservedExecuted: 0 };
  }

  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  // Rule 3: 매수창 09:05 ~ 09:55
  const isBuyWindow = hour === 9 && minute >= 5;

  const { appKey, appSecret } = await import('./kisAuth').then(m => m.getKisConfig());
  if (!appKey || !appSecret) {
    logger.debug('KIS not configured, skip tick');
    return { evaluated: 0, bought: 0, sold: 0, reservedExecuted: 0 };
  }
  const token = await getAccessToken();

  // 매도 평가 — 항상 실행
  const holdings = getHoldings();
  let sold = 0;
  for (const holding of holdings) {
    const r = await evaluateSellForHolding(holding, token);
    if (r.sold) sold++;
  }

  // 예약 주문 평가 — 항상 실행
  const reservedExecuted = await evaluateReservedOrders(token);

  // 매수 평가 — 매수창 + 시장 brake OK일 때만
  let bought = 0;
  let evaluated = 0;
  let brakeReason: string | undefined;
  if (isBuyWindow) {
    // 시장 brake 체크 (HIGH #1)
    const brake = await checkMarketBrake();
    if (brake.shouldBrake) {
      brakeReason = brake.reason;
      await logSystemEvent('WARN', 'MARKET_BRAKE',
        `시장 브레이크 — 신규 매수 차단`, brake.reason, '');
    } else {
      // 보유금액 기반 종목당 한도 (Rule 4)
      const orderable = await getDomesticOrderableAmount().catch(() => 0);
      const totalBudget = orderable > 0 ? orderable : settings.autoTradeMaxInvestment;
      const perStockBudget = totalBudget / Math.max(settings.positionMaxPositions, 1);

      const targets = listActiveTargets();
      // 매수 후 갱신된 holdings 사용 (매도 직후 재매수 방지)
      const refreshedHoldings = getHoldings();

      for (const target of targets) {
        evaluated++;
        const r = await evaluateBuyForTarget(target, perStockBudget, refreshedHoldings, token);
        if (r.bought) {
          bought++;
          // 새 보유 추가 (다음 평가 종목의 동일 섹터 집중도 정확히 계산)
          const sec = target.sector || '';
          refreshedHoldings.push({
            stockId: target.stockId,
            ticker: target.ticker,
            market: 'KRX',
            sector: sec,
            quantity: 1,
            avgPrice: 0,
            isFromToday: true,
          });
        }
      }
    }
  }

  if (bought + sold + reservedExecuted > 0 || brakeReason) {
    logger.info({ evaluated, bought, sold, reservedExecuted, brakeReason }, 'fiveMinTick');
  }
  return { evaluated, bought, sold, reservedExecuted, brakeReason };
}

// ── EOD ──

/** Rule 10: 15:00 — +eodProfitTakePercent 이상 보유분 익절. */
export async function runEodProfitTake(): Promise<{ sold: number }> {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) return { sold: 0 };
  const threshold = settings.eodProfitTakePercent ?? 3.0;

  const { appKey, appSecret } = await import('./kisAuth').then(m => m.getKisConfig());
  if (!appKey || !appSecret) return { sold: 0 };
  const token = await getAccessToken();

  const holdings = getHoldings();
  let sold = 0;
  for (const holding of holdings) {
    const snap = await getKisStockSnapshot(holding.ticker, token);
    const currentPrice = snap?.price ?? 0;
    if (currentPrice <= 0) continue;
    const pnlPct = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
    if (pnlPct < threshold) continue;

    try {
      const result = await executeOrder({
        stockId: holding.stockId,
        ticker: holding.ticker,
        market: 'KRX',
        orderType: 'SELL',
        quantity: holding.quantity,
        price: 0,
        reason: 'EOD_PROFIT_TAKE',
      });
      if (result.success) {
        sold++;
        resetPeakPrice(holding.stockId);
        markSold(holding.stockId);
        await logSystemEvent('INFO', 'EOD_PROFIT_TAKE',
          `15:00 익절: ${holding.ticker} ${result.quantity}주 (+${pnlPct.toFixed(2)}%)`,
          '', holding.ticker,
        );
      }
    } catch (err) {
      logger.error({ err, ticker: holding.ticker }, 'EOD profit take exception');
    }
  }
  return { sold };
}

/** Rule 11: 15:20 (동시호가 직전) — 당일 매수분 강제 정리. */
export async function runEodForceClose(): Promise<{ sold: number }> {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) return { sold: 0 };

  const holdings = getHoldings().filter(h => h.isFromToday);
  let sold = 0;
  for (const holding of holdings) {
    try {
      const result = await executeOrder({
        stockId: holding.stockId,
        ticker: holding.ticker,
        market: 'KRX',
        orderType: 'SELL',
        quantity: holding.quantity,
        price: 0,
        reason: 'EOD_FORCE_CLOSE',
      });
      if (result.success) {
        sold++;
        resetPeakPrice(holding.stockId);
        markSold(holding.stockId);
        await logSystemEvent('INFO', 'EOD_FORCE_CLOSE',
          `당일 정리: ${holding.ticker} ${result.quantity}주`,
          '', holding.ticker,
        );
      }
    } catch (err) {
      logger.error({ err, ticker: holding.ticker }, 'EOD force close exception');
    }
  }
  return { sold };
}

/** EOD 일일 리포트 — 15:50 cron. system_events에 요약 기록 (HIGH #7 + MEDIUM #13). */
export async function runEodReport(): Promise<{ summary: string }> {
  const today = new Date().toISOString().slice(0, 10);

  const counts = queryOne<{ buy_cnt: number; sell_cnt: number; failed_cnt: number; brake_cnt: number }>(`
    SELECT
      (SELECT COUNT(*) FROM auto_trades WHERE order_type='BUY' AND status='FILLED' AND date(created_at) = ?) as buy_cnt,
      (SELECT COUNT(*) FROM auto_trades WHERE order_type='SELL' AND status='FILLED' AND date(created_at) = ?) as sell_cnt,
      (SELECT COUNT(*) FROM auto_trades WHERE status='FAILED' AND date(created_at) = ?) as failed_cnt,
      (SELECT COUNT(*) FROM system_events WHERE category='MARKET_BRAKE' AND date(created_at) = ?) as brake_cnt
  `, [today, today, today, today]);

  const realized = queryOne<{ buy_amt: number; sell_amt: number }>(`
    SELECT
      COALESCE(SUM(CASE WHEN type='BUY' THEN quantity * price ELSE 0 END), 0) as buy_amt,
      COALESCE(SUM(CASE WHEN type='SELL' THEN quantity * price ELSE 0 END), 0) as sell_amt
    FROM transactions
    WHERE date(date) = ? AND deleted_at IS NULL
  `, [today]);

  const buyAmt = realized?.buy_amt ?? 0;
  const sellAmt = realized?.sell_amt ?? 0;
  const netFlow = sellAmt - buyAmt;

  const summary = `매수 ${counts?.buy_cnt ?? 0}건, 매도 ${counts?.sell_cnt ?? 0}건, 실패 ${counts?.failed_cnt ?? 0}건, 시장 brake ${counts?.brake_cnt ?? 0}회. 순현금흐름 ${Math.round(netFlow).toLocaleString()}원`;

  await logSystemEvent('INFO', 'EOD_REPORT',
    `일일 매매 요약 (${today})`, summary, '');

  logger.info({ today, ...counts, buyAmt, sellAmt, netFlow }, '[EOD] 일일 리포트');
  return { summary };
}

// ── 만료 정리 ──

export function runExpiry(): { reservedExpired: number } {
  return { reservedExpired: expireStaleReserved() };
}
