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
  listActiveByStock as listActiveReservedByStock,
  isTriggered,
  markExecuted,
  recordExecutionAttempt,
  expireStale as expireStaleReserved,
} from './reservedOrders';
import { evaluateSellRules, resetPeakPrice, getBuyTimestamp } from './sellRules';
import { chaseStaleOrders } from './orderChase';
import {
  setOpeningPriceIfMissing,
  markBought,
  markSold,
  isInCooldown,
  isBoughtToday,
  syncTodayFromTransactions,
  getState,
  setEntryExitPlan,
  markT1Filled,
  moveSLToBE,
} from './intradayState';
import { getCachedEntryExitPlan } from './entryExitPlan';
import { fetchDailyCandles } from './candleData';
import { hasBearishPattern, hasBullishPattern } from './candlePatterns';
import { calcRSI, calcSMA } from './technicalAnalysis';
import { getContextLevel } from './marketContextMonitor';
import { recordSetupOnBuy, recordResultOnSell } from './tradeSetupLog';
import { checkMarketBrake } from './marketBrake';
import { getQuoteBook } from './quoteBook';
import { executeOrder, getDomesticOrderableAmount } from './kisOrder';
import { logSystemEvent } from './systemEvent';
import logger from '../logger';

// ── 상수 (settings 미노출) ──

const SAME_SECTOR_MAX = 2;        // 동일 섹터 최대 보유 (HIGH #9)
const MIN_VOLUME_RATIO = 0.8;     // 5일 평균 대비 거래량 비율 (HIGH #4)
const POSITION_TOLERANCE = 0.05;  // ±5% (사용자 안)

// ── 알림 dedup (대시보드 noise 방지) ──
//   매수창(09:05~09:55) 동안 매분 tick 이 돌면서 동일 사유 알림이 폭주하는 문제.
//   같은 트리거 종류(KOSPI/VIX) 가 30분 내 재발생하면 silent.
//   process restart 시 초기화 → 재시작 직후 1회는 항상 emit.
const ALERT_DEDUP_MS = 30 * 60 * 1000;
let lastBrakeEmitAt = 0;
let lastBrakeKey = '';
let lastNoCashEmitAt = 0;

function brakeTriggerKey(reason: string): string {
  const triggers: string[] = [];
  if (reason.includes('KOSPI')) triggers.push('KOSPI');
  if (reason.includes('VIX')) triggers.push('VIX');
  return triggers.join('/') || 'OTHER';
}

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
  /** 현재 포지션이 시작된 시점 (마지막으로 qty=0 직후의 첫 BUY created_at). null = 아직 매수 안 됨 */
  positionOpenedAt: string | null;
}

interface TxRow {
  stock_id: number;
  ticker: string;
  market: string;
  sector: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  created_at: string;
}

/**
 * 시간순 lot-tracking 으로 현재 보유분의 정확한 평균 단가와 포지션 개시 시각을 계산.
 *
 * 기존 SQL은 SUM(BUY qty*price)/SUM(BUY qty) 을 사용해 누적 모든 BUY 를 평균 → 부분/전량
 * 매도 후 재매수 시 cost basis 가 잘못 계산되어 STOP_LOSS / LOSS_TIME 이 잘못 트리거.
 *
 * 표준 평균원가 방식:
 *   - BUY: cost += qty*price, qty += qty
 *   - SELL: cost = cost * (qty - sold) / qty, qty -= sold
 *   - qty <= 0 도달 시 cost/positionOpenedAt 모두 0/null 로 reset (포지션 종료)
 *   - qty 0 → 양수 전환 시 새 BUY 의 created_at 을 positionOpenedAt 으로 기록
 */
function getHoldings(): HoldingInfo[] {
  const txs = queryAll<TxRow>(`
    SELECT s.id as stock_id, s.ticker,
           COALESCE(s.market, 'KRX') as market,
           COALESCE(s.sector, '') as sector,
           t.type, t.quantity, t.price, t.created_at
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY s.id, datetime(t.created_at), t.id
  `);

  type Acc = {
    ticker: string;
    market: string;
    sector: string;
    qty: number;
    cost: number;
    positionOpenedAt: string | null;
  };
  const grouped = new Map<number, Acc>();

  for (const tx of txs) {
    let g = grouped.get(tx.stock_id);
    if (!g) {
      g = { ticker: tx.ticker, market: tx.market, sector: tx.sector, qty: 0, cost: 0, positionOpenedAt: null };
      grouped.set(tx.stock_id, g);
    }
    if (tx.type === 'BUY') {
      if (g.qty <= 0) g.positionOpenedAt = tx.created_at; // 신규 포지션 개시
      g.cost += tx.quantity * tx.price;
      g.qty += tx.quantity;
    } else {
      // SELL: cost 비례 차감, 전량 매도 시 reset
      if (g.qty > 0) {
        const sellQty = Math.min(tx.quantity, g.qty);
        g.cost = g.cost * (g.qty - sellQty) / g.qty;
        g.qty -= sellQty;
      }
      if (g.qty <= 0) {
        g.qty = 0;
        g.cost = 0;
        g.positionOpenedAt = null;
      }
    }
  }

  const holdings: HoldingInfo[] = [];
  for (const [stockId, g] of grouped) {
    if (g.qty <= 0) continue;
    holdings.push({
      stockId,
      ticker: g.ticker,
      market: g.market,
      sector: g.sector,
      quantity: g.qty,
      avgPrice: g.cost / g.qty,
      isFromToday: isBoughtToday(stockId),
      positionOpenedAt: g.positionOpenedAt,
    });
  }
  return holdings;
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
  currentHoldings: HoldingInfo[],
  token: string,
): Promise<{ bought: boolean; reason: string }> {
  const settings = getSettings();
  const entryGain = settings.entryGainPercent ?? 1.0;
  const cooldownMin = settings.reEntryCooldownMinutes ?? 30;

  // 0. 예약 매수/매도가 걸린 종목은 자동매수 스킵 (사용자 정책: 예약주문이 우선)
  if (listActiveReservedByStock(target.stockId).length > 0) {
    return { bought: false, reason: 'reserved-order-active' };
  }

  // 1. 이미 보유 중이면 스킵
  const existingHolding = currentHoldings.find(h => h.stockId === target.stockId);
  if (existingHolding) {
    return { bought: false, reason: 'already holding' };
  }

  // 2. 오늘 이미 한 번 매수했으면 스킵 (재매수 방지)
  if (isBoughtToday(target.stockId)) {
    return { bought: false, reason: 'already bought today' };
  }

  // 3. 재진입 cooldown
  if (isInCooldown(target.stockId, cooldownMin)) {
    return { bought: false, reason: `cooldown ${cooldownMin}분 미경과` };
  }

  // 4. 동일 섹터 집중도
  if (target.sector) {
    const sameSectorCount = currentHoldings.filter(h => h.sector === target.sector).length;
    if (sameSectorCount >= SAME_SECTOR_MAX) {
      return { bought: false, reason: `섹터 ${target.sector} 이미 ${sameSectorCount}종목` };
    }
  }

  // 5. KIS snapshot
  const snap = await getKisStockSnapshot(target.ticker, token);
  if (!snap || snap.price <= 0) {
    return { bought: false, reason: 'KIS 시세 조회 실패' };
  }

  // 6. VI 발동 종목 차단
  if (snap.viActivated) {
    return { bought: false, reason: 'VI 발동 종목' };
  }

  // 7. 시초가 baseline 기록
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

  // 9. 거래량 검증
  const volRatio = await getVolumeRatio(target.ticker, snap.volume);
  if (volRatio < MIN_VOLUME_RATIO) {
    return { bought: false, reason: `거래량 부족 (${volRatio.toFixed(2)}x < ${MIN_VOLUME_RATIO}x)` };
  }

  // 10. 호가 품질 게이트
  try {
    const qb = await getQuoteBook(target.ticker, 'KRX');
    if (qb && qb.quality === 'POOR') {
      return { bought: false, reason: `호가 품질 POOR (스프레드 ${qb.spreadPercent.toFixed(2)}%)` };
    }
  } catch {}

  // 10.5. Pre-trade technicals + 캔들 패턴 게이트 (v5.4.0)
  //   - 약세 캔들 패턴 출현: 진입 차단
  //   - RSI > 75 (과매수): 진입 차단
  //   - 5MA 미달 (현재가 < 5MA × 0.99): 추세 약화 → 진입 차단
  //   - 통과 시 컨피던스 가중치 계산 (1.0~1.5)
  let confidenceMultiplier = 1.0;
  let confidenceReasons: string[] = [];
  let setupBullishPattern: string | null = null;
  let setupRsi: number | null = null;
  try {
    const candles = await fetchDailyCandles(target.ticker, { days: 30 });
    if (candles.length >= 6) {
      const bear = hasBearishPattern(candles);
      if (bear.found && bear.description) {
        return { bought: false, reason: `약세 캔들 패턴 (${bear.description})` };
      }
      const closes = candles.map(c => c.close);
      const rsi = calcRSI(closes, 14);
      setupRsi = rsi;
      if (rsi !== null && rsi > 75) {
        return { bought: false, reason: `RSI ${rsi.toFixed(1)} 과매수 영역` };
      }
      const sma5 = calcSMA(closes, 5);
      const sma20 = calcSMA(closes, 20);
      if (sma5 !== null && snap.price < sma5 * 0.99) {
        return { bought: false, reason: `5MA 이탈 (현재 ${snap.price} < 5MA ${sma5.toFixed(0)} × 0.99)` };
      }
      // 강세 패턴 감지 시 가중치 +0.15 + reason 표시
      const bull = hasBullishPattern(candles);
      if (bull.found && bull.description) {
        confidenceMultiplier += 0.15;
        confidenceReasons.push(`강세패턴(${bull.description})`);
        setupBullishPattern = bull.pattern ?? null;
      }
      // RSI 50~65 (sweet spot, 과매수 직전 아님) 가중치 +0.10
      if (rsi !== null && rsi >= 50 && rsi <= 65) {
        confidenceMultiplier += 0.10;
        confidenceReasons.push(`RSI ${rsi.toFixed(0)}`);
      }
      // 5MA > 20MA 정배열 가중치 +0.10
      if (sma5 !== null && sma20 !== null && sma5 > sma20) {
        confidenceMultiplier += 0.10;
        confidenceReasons.push('정배열');
      }
      // 거래량 1.5x 초과 가중치 +0.05
      if (volRatio > 1.5) {
        confidenceMultiplier += 0.05;
        confidenceReasons.push(`vol×${volRatio.toFixed(1)}`);
      }
      confidenceMultiplier = Math.min(confidenceMultiplier, 1.5);
    }
  } catch {}

  // 11. KIS 주문 실행 — quantity=0으로 위임 (executeOrder 내부 checkPositionSizingRules가 정책 적용:
  //     한도 내 floor(budget/price), 한도 초과 시 1주, 가용현금 90% 초과 시 차단)
  try {
    const confidenceLabel = confidenceMultiplier > 1.0
      ? ` | conf×${confidenceMultiplier.toFixed(2)} (${confidenceReasons.join(',')})`
      : '';
    const result = await executeOrder({
      stockId: target.stockId,
      ticker: target.ticker,
      market: 'KRX',
      orderType: 'BUY',
      quantity: 0,
      price: 0,
      reason: `시초가+${gainFromOpen.toFixed(1)}% 진입 (vol×${volRatio.toFixed(1)})${confidenceLabel}`,
      confidenceMultiplier,
    });
    if (result.success) {
      markBought(target.stockId, result.price);

      // Setup feature 저장 (사후 분석용 — Tier 3.2)
      recordSetupOnBuy({
        stockId: target.stockId,
        ticker: target.ticker,
        sector: target.sector ?? null,
        boughtPrice: result.price,
        bullishPattern: setupBullishPattern,
        rsi: setupRsi,
        volRatio,
        confidenceMultiplier,
        gainFromOpen,
        strategicCategory: target.category ?? null,
        reason: target.reason,
      });

      // Entry/Exit Plan 계산 + 저장 (실패해도 매수 자체는 성공으로 처리)
      try {
        const plan = await getCachedEntryExitPlan(target.ticker, result.price);
        if (plan) {
          setEntryExitPlan(target.stockId, {
            t1Target: plan.t1Target,
            t2Target: plan.t2Target,
            dynamicSL: plan.dynamicSL,
            entryAvgPrice: result.price,
          });
          await logSystemEvent('INFO', 'ENTRY_EXIT_PLAN',
            `매매 계획: ${target.ticker} T1 ${plan.t1Target.toLocaleString()} / T2 ${plan.t2Target.toLocaleString()} / SL ${plan.dynamicSL.toLocaleString()}`,
            plan.reason,
            target.ticker,
          );
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, ticker: target.ticker }, 'computeEntryExitPlan failed (룰 동작 영향 없음)');
      }

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

async function evaluateSellForHolding(holding: HoldingInfo, token: string): Promise<{ sold: boolean; rule?: string; skippedReason?: string }> {
  // 안전 가드 1: 자동매매 엔진이 오늘 직접 진입(자동매수 / 예약체결)한 포지션만 자동매도.
  // KIS 동기화된 장기보유분, 사용자가 직접 거래한 종목은 절대 건드리지 않음.
  if (!holding.isFromToday) {
    return { sold: false, skippedReason: 'not-engine-position' };
  }

  // 안전 가드 2: 예약 매수/매도가 걸린 종목은 자동매매 룰 미적용 → 예약 조건만 트리거.
  if (listActiveReservedByStock(holding.stockId).length > 0) {
    return { sold: false, skippedReason: 'reserved-order-active' };
  }

  const snap = await getKisStockSnapshot(holding.ticker, token);
  const currentPrice = snap?.price ?? 0;
  if (currentPrice <= 0) return { sold: false };

  const unrealizedPnLPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

  // 약세 캔들 패턴 검출 (캐시된 일봉 사용 — 5분 cache, 1분 모니터에 부담 적음)
  let bearishPattern: { pattern: string; description: string } | null = null;
  try {
    const candles = await fetchDailyCandles(holding.ticker, { days: 30 });
    if (candles.length >= 6) {
      const r = hasBearishPattern(candles);
      if (r.found && r.pattern && r.description) {
        bearishPattern = { pattern: r.pattern, description: r.description };
      }
    }
  } catch {}

  // 시장 컨텍스트 평가 (분당 cron 이 누적한 KOSPI/VIX 트렌드)
  const ctx = getContextLevel();

  const result = evaluateSellRules({
    stockId: holding.stockId,
    ticker: holding.ticker,
    currentPrice,
    avgPrice: holding.avgPrice,
    quantity: holding.quantity,
    unrealizedPnLPercent,
    positionOpenedAt: holding.positionOpenedAt,
    bearishPattern,
    contextLevel: ctx.level,
    contextReason: ctx.reason,
  });

  if (!result.shouldSell) return { sold: false };

  // 부분 매도 비율 → 정수 수량으로 변환. 최소 1주 보장. 잔여 0주 되지 않도록 cap.
  const ratio = result.partialRatio ?? 1.0;
  const isPartial = ratio < 1.0;
  let sellQty = isPartial ? Math.floor(holding.quantity * ratio) : holding.quantity;
  if (sellQty < 1) sellQty = 1;
  if (sellQty >= holding.quantity) {
    // 부분이 전량을 넘으면 전량으로 처리
    sellQty = holding.quantity;
  }

  // v5.4.0 — 익절 룰일 때만 호가 호의적이면 지정가 (슬리피지 절약).
  //          손절/패턴 룰은 항상 시장가 (빠른 청산 우선).
  const isProfitRule = result.rule === 'PARTIAL_T1' || result.rule === 'FULL_T2' || result.rule === 'TARGET_PROFIT';

  try {
    const sellResult = await executeOrder({
      stockId: holding.stockId,
      ticker: holding.ticker,
      market: 'KRX',
      orderType: 'SELL',
      quantity: sellQty,
      price: 0,
      reason: result.rule ?? '',
      preferLimitOnSell: isProfitRule,
    });
    if (sellResult.success) {
      const partialFlag = sellQty < holding.quantity;

      if (partialFlag) {
        // 부분 매도 — peak/cooldown 유지, T1_FILLED + Move-to-BE 마킹
        if (result.rule === 'PARTIAL_T1') {
          markT1Filled(holding.stockId);
          moveSLToBE(holding.stockId);
        }
      } else {
        // 전량 매도 — 기존 동작 유지 + setup 결과 기록
        resetPeakPrice(holding.stockId);
        markSold(holding.stockId);
        recordResultOnSell({
          stockId: holding.stockId,
          rule: result.rule ?? 'UNKNOWN',
          soldPrice: sellResult.price,
        });
      }

      await logSystemEvent('INFO', 'AUTO_SELL',
        `자동매도(${result.rule}${partialFlag ? ' · 분할' : ''}): ${holding.ticker} ${sellResult.quantity}주 @ ${sellResult.price.toLocaleString()}`,
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
      // KIS 가용 현금 ÷ positionMaxPositions 기반 자동 산정
      const settings = getSettings();
      const cash = await getDomesticOrderableAmount().catch(() => 0);
      if (cash > 0) {
        const perStockBudget = cash / Math.max(settings.positionMaxPositions, 1);
        qty = Math.max(1, Math.floor(perStockBudget / currentPrice));
      }
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
export interface MonitorTickResult {
  evaluated: number;          // 매수 후보 평가 수 (target 기준)
  evaluatedSells: number;     // 매도 후보 평가 수 (holding 기준)
  bought: number;
  sold: number;
  reservedExecuted: number;
  brakeReason?: string;
}

export async function runMonitorTick(): Promise<MonitorTickResult> {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    return { evaluated: 0, evaluatedSells: 0, bought: 0, sold: 0, reservedExecuted: 0 };
  }

  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  // Rule 3: 매수창 09:05 ~ 09:55
  const isBuyWindow = hour === 9 && minute >= 5;

  const { appKey, appSecret } = await import('./kisAuth').then(m => m.getKisConfig());
  if (!appKey || !appSecret) {
    logger.debug('KIS not configured, skip tick');
    return { evaluated: 0, evaluatedSells: 0, bought: 0, sold: 0, reservedExecuted: 0 };
  }
  const token = await getAccessToken();

  // 미체결 주문 chase — stale (5분 이상) 주문 가격 갱신
  try {
    const chase = await chaseStaleOrders(false);
    if (chase.chased > 0) {
      logger.info(chase, '[Tick] orderChase');
    }
  } catch (err) {
    logger.error({ err }, '[Tick] chaseStaleOrders failed');
  }

  // 매도 평가 — 항상 실행
  const holdings = getHoldings();
  const evaluatedSells = holdings.length;
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
      const now = Date.now();
      const key = brakeTriggerKey(brake.reason);
      const sameKeyRecently = key === lastBrakeKey && now - lastBrakeEmitAt < ALERT_DEDUP_MS;
      if (!sameKeyRecently) {
        await logSystemEvent('WARN', 'MARKET_BRAKE',
          `시장 브레이크 — 신규 매수 차단`, brake.reason, '');
        lastBrakeEmitAt = now;
        lastBrakeKey = key;
      }
    } else {
      // KIS 가용 현금 사전 체크 (실제 sizing은 executeOrder 내부에서 매번 재조회)
      const cashAmount = await getDomesticOrderableAmount().catch(() => 0);
      if (cashAmount <= 0) {
        const now = Date.now();
        if (now - lastNoCashEmitAt >= ALERT_DEDUP_MS) {
          await logSystemEvent('WARN', 'NO_CASH',
            '주문가능금액 0 — 매수 평가 스킵', 'KIS API 잔고 확인 필요', '');
          lastNoCashEmitAt = now;
        }
        return { evaluated: 0, evaluatedSells, bought: 0, sold, reservedExecuted };
      }

      const targets = listActiveTargets();
      const refreshedHoldings = getHoldings();

      for (const target of targets) {
        evaluated++;
        const r = await evaluateBuyForTarget(target, refreshedHoldings, token);
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
            positionOpenedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  if (bought + sold + reservedExecuted > 0 || brakeReason) {
    logger.info({ evaluated, evaluatedSells, bought, sold, reservedExecuted, brakeReason }, 'fiveMinTick');
  }
  return { evaluated, evaluatedSells, bought, sold, reservedExecuted, brakeReason };
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

  // 엔진 진입분만 + 예약주문 미걸린 종목만
  const holdings = getHoldings().filter(h => h.isFromToday);
  let sold = 0;
  for (const holding of holdings) {
    if (listActiveReservedByStock(holding.stockId).length > 0) continue;

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
    // 예약주문이 걸린 종목은 EOD 강제정리도 스킵 — 사용자 의도(예약 조건만 트리거)
    if (listActiveReservedByStock(holding.stockId).length > 0) continue;

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
