/**
 * v5.7.0 Rebalance Strategy.
 *
 * 통합 매매 의사결정. top10Strategy 의 단순 "Top10 이탈 → 매도, 진입 → 매수"
 * 룰을 다음으로 확장:
 *
 *   매도:
 *     S1. 트레일링 스톱   — +10% 도달 → 활성화, 고점 대비 -2% 이탈 시 매도
 *     S2. 순위 이탈       — 매수 시점 순위(buy_rank) 보다 현재 순위가 떨어지면 매도
 *                          (보유 + Top 20 밖이면 자동 떨어진 것으로 간주)
 *     S3. KOSPI +4% 상승  — 수익 +5% 이상 종목 매도 (이익실현 + 현금화)
 *
 *   매수:
 *     B1. 시장 브레이크   — 죽는 시장(5MA<20MA + KOSPI -2%)이거나 marketBrake 발동이면 차단
 *     B2. 미보유 Top 10   — 시총 1위부터 1주씩 시도 (기존 로직 유지)
 *     B3. 11~20위 상승 중 — 직전 24h 대비 순위가 2단계+ 상승했으면 매수 후보
 *     B4. 재분배          — 잔고 남으면 보유 종목 중 평가금액 최저부터 1주씩
 *
 *   특별 cron:
 *     - 14:30 평일: KOSPI +4% 이상이면 S3 만 평가 (장 마감 전 이익실현)
 *
 * 멱등성:
 *   - 같은 분기점(같은 Top 20 스냅샷) 으로 두 번 돌리면 같은 결과.
 *   - 트레일링 활성/순위 기록은 매수 시 1회 INSERT, 매시간 갱신.
 */

import { fetchTop10, isRankImproving, type TopStock } from './topMarketCap';
import { getSettings } from './settings';
import { executeOrder, getDomesticOrderableAmount } from './kisOrder';
import { checkMarketBrake } from './marketBrake';
import { getKospiDailyChange, detectDyingMarket } from './marketSignals';
import { logSystemEvent } from './systemEvent';
import { normalizeMarket } from './marketNormalizer';
import { fetchYahooQuote } from './stockPrice';
import { queryAll, queryOne, execute } from '../db';
import logger from '../logger';

// ─────────────────────────────────────────────────────────────
// 임계값 (settings 로 빼지 않고 상수 — 백테스트 후 조정 시 일괄 수정)
//
// v5.8.0 — 멀티 레짐(2020 폭락 / 2022 하락 / 2025 폭등) 백테스트로 확정:
//   · 순위 이탈 즉시매도 → 히스테리시스(Top20 이탈 + 2회 연속 확인): 3개 레짐 전부
//     baseline 개선, 거래 5~10배↓, 단일 상승장 기준 순위이탈 -188만원 출혈 제거.
//   · 트레일링 -2% 는 유지(완화 시 3개 레짐 모두 악화) / 하드 손절은 거부(휩쏘).
//   상세: scripts/backtest-harness.mjs, docs/backtest-v5.7/STRATEGY_REVIEW.md
// ─────────────────────────────────────────────────────────────
const TRAILING_ACTIVATION_PCT = 10; // 수익 +10% 도달 시 트레일링 활성화
const TRAILING_STOP_DROP_PCT = 2;   // 활성 후 고점 대비 -2% 시 매도 (백테스트상 유지가 최선)
const KOSPI_BUY_TRIGGER = -4;       // KOSPI -4% 이하: 적극 매수 모드 (현재는 marketBrake 와 별도 로깅만)
const KOSPI_SELL_TRIGGER = 4;       // KOSPI +4% 이상: 이익 실현 매도 트리거
const KOSPI_SELL_PROFIT_MIN = 5;    // 위 트리거 시 매도 대상은 +5% 이상 수익 종목
const RANK_IMPROVE_HOURS = 24;      // "직전 24h 대비"
const RANK_IMPROVE_THRESHOLD = 2;   // 2단계 이상 상승해야 매수 후보
// v5.8.0 순위 이탈 매도 — 히스테리시스(이력 현상)
const EXIT_RANK_THRESHOLD = 20;     // 모니터링 유니버스(Top 20) 밖으로 이탈해야 매도 후보
const EXIT_CONFIRM_TICKS = 2;       // 연속 N회(매시간 cron 기준) 이탈 확인돼야 실제 매도 (노이즈 필터)
const REBAL_MAX_ITER = 30;

// ─────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────

export interface RebalanceTrade {
  ticker: string;
  name: string;
  quantity: number;
  price?: number;
  reason?: string;
}

export interface RebalanceSkip {
  ticker: string;
  name: string;
  reason: string;
}

export interface RebalanceResult {
  reason: string;
  fetchedAt: string;
  kospiChangePercent: number | null;
  top10Tickers: string[];
  sold: RebalanceTrade[];
  bought: RebalanceTrade[];
  skipped: RebalanceSkip[];
  brakeReason?: string;
  dyingMarketReason?: string;
  noop: boolean;
  mode?: 'normal' | 'kospi-spike-sell-only'; // 14:30 special cron
}

interface PositionRow {
  stock_id: number;
  ticker: string;
  name: string;
  market: string;
  qty: number;
  avg_price: number;
}

interface Position extends PositionRow {
  currentPrice: number;
  profitPercent: number;
  // tracking 행 (없으면 미설정)
  buyRank: number | null;
  highestPrice: number | null;
  trailingActive: boolean;
  outOfUniverseCount: number; // v5.8 히스테리시스 — Top 20 밖 연속 관측 횟수
}

// ─────────────────────────────────────────────────────────────
// 보유 종목 조회 + 추적 데이터 머지
// ─────────────────────────────────────────────────────────────

function getCurrentPositions(): PositionRow[] {
  return queryAll<PositionRow>(`
    SELECT s.id as stock_id, s.ticker, s.name, COALESCE(s.market, 'KRX') as market,
           COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END), 0) as qty,
           CASE
             WHEN SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END) > 0
             THEN SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END)
                  / SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END)
             ELSE 0
           END as avg_price
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING qty > 0
  `);
}

interface TrackingRow {
  stock_id: number;
  buy_rank: number;
  highest_price: number;
  trailing_active: number;
  out_of_universe_count: number;
  last_out_date: string | null;
}

function getTracking(stockId: number): TrackingRow | null {
  return queryOne<TrackingRow>(
    `SELECT stock_id, buy_rank, highest_price, trailing_active,
            COALESCE(out_of_universe_count, 0) as out_of_universe_count, last_out_date
     FROM position_tracking WHERE stock_id = ?`,
    [stockId],
  );
}

/** 매수 시 호출. 행이 없으면 INSERT, 있으면 buy_rank/buy_price 만 갱신 (재진입). */
function upsertTrackingOnBuy(stockId: number, rank: number, price: number): void {
  const existing = getTracking(stockId);
  if (!existing) {
    execute(
      `INSERT INTO position_tracking (stock_id, buy_rank, buy_price, highest_price, trailing_active, updated_at)
       VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
      [stockId, rank, price, price],
    );
  } else {
    // 재매수: buy_rank 를 현재 매수 시점으로 갱신, highest_price 도 max 로 재설정
    execute(
      `UPDATE position_tracking
       SET buy_rank = ?, buy_price = ?, highest_price = MAX(highest_price, ?), updated_at = CURRENT_TIMESTAMP
       WHERE stock_id = ?`,
      [rank, price, price, stockId],
    );
  }
}

/** 보유분 0 매도 시 호출. trailing 비활성화 + highest 초기화. */
function resetTrackingOnSell(stockId: number): void {
  execute('DELETE FROM position_tracking WHERE stock_id = ?', [stockId]);
}

/**
 * tracking 행이 없으면 lazy 생성 (가져오기/EOD reconcile 로 들어온 레거시 보유분 대응).
 * 트레일링·히스테리시스가 모든 보유 종목에 일관 적용되도록 보장.
 * buy_rank 는 현재 순위(미상이면 EXIT_RANK_THRESHOLD+1) 로 추정.
 */
function ensureTracking(stockId: number, currentRank: number, currentPrice: number): void {
  const existing = getTracking(stockId);
  if (existing) return;
  const rank = currentRank >= 999 ? EXIT_RANK_THRESHOLD + 1 : currentRank;
  execute(
    `INSERT INTO position_tracking (stock_id, buy_rank, buy_price, highest_price, trailing_active, out_of_universe_count, last_out_date, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, NULL, CURRENT_TIMESTAMP)`,
    [stockId, rank, currentPrice, currentPrice],
  );
}

/** 매시간 갱신: 현재가가 highest_price 보다 높으면 highest_price 업데이트. */
function updateHighestPrice(stockId: number, currentPrice: number): void {
  execute(
    `UPDATE position_tracking
     SET highest_price = ?, updated_at = CURRENT_TIMESTAMP
     WHERE stock_id = ? AND ? > highest_price`,
    [currentPrice, stockId, currentPrice],
  );
}

function activateTrailing(stockId: number): void {
  execute(
    'UPDATE position_tracking SET trailing_active = 1, updated_at = CURRENT_TIMESTAMP WHERE stock_id = ?',
    [stockId],
  );
}

/**
 * v5.8 히스테리시스 카운터 상태 전이 — 순수 함수 (DB 무관, 단위 테스트 대상).
 *
 * 백테스트가 일봉 기준 2일 확인으로 검증됐으나 운영 cron 은 시간당(하루 6회) 실행이므로,
 * 단순 호출 횟수로 세면 2시간 만에 매도돼 백테스트보다 과민해진다. 따라서 하루에 한 번만
 * 카운트를 올린다(같은 today 면 중복 증가 없음) → EXIT_CONFIRM_TICKS=2 = 연속 2거래일.
 */
export function nextOutOfUniverseState(
  prev: { count: number; lastOutDate: string | null },
  isOutside: boolean,
  today: string,
): { count: number; lastOutDate: string | null; changed: boolean } {
  if (!isOutside) {
    const changed = prev.count !== 0 || prev.lastOutDate !== null;
    return { count: 0, lastOutDate: null, changed };
  }
  // 이미 오늘 카운트를 올렸으면 현재값 유지 (하루 여러 cron 에서 중복 증가 방지)
  if (prev.lastOutDate === today) {
    return { count: prev.count, lastOutDate: prev.lastOutDate, changed: false };
  }
  return { count: prev.count + 1, lastOutDate: today, changed: true };
}

/**
 * 히스테리시스 카운터 DB 반영. nextOutOfUniverseState 로 전이 계산 후 변경 시만 UPDATE.
 * @returns 갱신 후 누적 카운트 (연속 Top 20 밖 거래일 수)
 */
function bumpOutOfUniverse(stockId: number, isOutside: boolean, today: string): number {
  const tracking = getTracking(stockId);
  if (!tracking) return 0;

  const next = nextOutOfUniverseState(
    { count: tracking.out_of_universe_count, lastOutDate: tracking.last_out_date },
    isOutside,
    today,
  );
  if (next.changed) {
    execute(
      'UPDATE position_tracking SET out_of_universe_count = ?, last_out_date = ?, updated_at = CURRENT_TIMESTAMP WHERE stock_id = ?',
      [next.count, next.lastOutDate, stockId],
    );
  }
  return next.count;
}

function ensureStockId(ticker: string, name: string, market: 'KOSPI' | 'KOSDAQ'): number {
  const existing = queryOne<{ id: number }>(
    'SELECT id FROM stocks WHERE ticker = ? AND deleted_at IS NULL',
    [ticker],
  );
  if (existing) return existing.id;
  execute(
    'INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)',
    [ticker, name, normalizeMarket(market), ''],
  );
  const inserted = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  if (!inserted) throw new Error(`stock insert failed: ${ticker}`);
  return inserted.id;
}

// ─────────────────────────────────────────────────────────────
// 현재가 조회 — Yahoo (KIS 호출 과다 회피)
// ─────────────────────────────────────────────────────────────

async function fetchPriceMap(tickers: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  await Promise.all(
    tickers.map(async (t) => {
      // Yahoo 한국 종목은 .KS / .KQ 접미사. KOSPI 우선 시도, 실패 시 KOSDAQ.
      // 짧은 캐시 의미 없음 — 각 호출은 매시간 1회.
      try {
        let q = await fetchYahooQuote(`${t}.KS`);
        if (!q) q = await fetchYahooQuote(`${t}.KQ`);
        if (q && q.price > 0) m.set(t, q.price);
      } catch {}
    }),
  );
  return m;
}

// ─────────────────────────────────────────────────────────────
// 메인 로직
// ─────────────────────────────────────────────────────────────

interface BuildContextResult {
  topResult: Awaited<ReturnType<typeof fetchTop10>>;
  positions: Position[];
  priceMap: Map<string, number>;
  kospiChange: number | null;
}

async function buildContext(): Promise<BuildContextResult> {
  const topResult = await fetchTop10(true);
  const positionRows = getCurrentPositions();

  // 현재가 일괄 조회 (보유 + Top 20)
  const top20 = topResult.top20 ?? topResult.top10;
  const tickersNeedingPrice = Array.from(
    new Set([...positionRows.map((p) => p.ticker), ...top20.map((s) => s.ticker)]),
  );
  const priceMap = await fetchPriceMap(tickersNeedingPrice);

  const positions: Position[] = positionRows.map((p) => {
    const tracking = getTracking(p.stock_id);
    const currentPrice = priceMap.get(p.ticker) ?? p.avg_price;
    const profitPercent = p.avg_price > 0
      ? Math.round(((currentPrice - p.avg_price) / p.avg_price) * 10000) / 100
      : 0;
    return {
      ...p,
      currentPrice,
      profitPercent,
      buyRank: tracking?.buy_rank ?? null,
      highestPrice: tracking?.highest_price ?? null,
      trailingActive: !!tracking?.trailing_active,
      outOfUniverseCount: tracking?.out_of_universe_count ?? 0,
    };
  });

  const kospi = await getKospiDailyChange();
  return { topResult, positions, priceMap, kospiChange: kospi?.changePercent ?? null };
}

interface SellDecision {
  position: Position;
  reason: string;
}

/**
 * 보유 종목별 매도 평가. evaluateOnly=true 면 트레일링 활성/highest 갱신만 하고 매도 후보만 반환.
 *
 * 우선순위 (한 종목당 첫 번째 만족하는 룰로 매도):
 *   1) 트레일링 스톱  (S1)
 *   2) 순위 이탈       (S2)
 *   3) KOSPI +4% + 수익 (S3)
 */
function evaluateSells(
  positions: Position[],
  topExtended: TopStock[],
  kospiChange: number | null,
  mode: 'normal' | 'kospi-spike-sell-only',
  today: string,
): SellDecision[] {
  const rankMap = new Map<string, number>();
  topExtended.forEach((s) => rankMap.set(s.ticker, s.rank));
  const decisions: SellDecision[] = [];

  for (const p of positions) {
    // 레거시 보유분(가져오기/EOD reconcile)도 트래킹되도록 lazy 생성
    const rankForInit = rankMap.get(p.ticker) ?? 999;
    ensureTracking(p.stock_id, rankForInit, p.currentPrice);
    // 트래킹 데이터 갱신 — 보유 중 최고가 추적은 매도 여부와 무관하게 매번
    updateHighestPrice(p.stock_id, p.currentPrice);
    if (!p.trailingActive && p.profitPercent >= TRAILING_ACTIVATION_PCT) {
      activateTrailing(p.stock_id);
      p.trailingActive = true;
    }

    // KOSPI 스파이크 매도 전용 모드: S3 만 평가
    if (mode === 'kospi-spike-sell-only') {
      if (kospiChange !== null && kospiChange >= KOSPI_SELL_TRIGGER && p.profitPercent >= KOSPI_SELL_PROFIT_MIN) {
        decisions.push({
          position: p,
          reason: `KOSPI +${kospiChange}% + 수익 +${p.profitPercent}% — 장중 이익실현`,
        });
      }
      continue;
    }

    // S1 트레일링 스톱
    if (p.trailingActive && p.highestPrice && p.highestPrice > 0) {
      const dropPct = ((p.highestPrice - p.currentPrice) / p.highestPrice) * 100;
      if (dropPct >= TRAILING_STOP_DROP_PCT) {
        decisions.push({
          position: p,
          reason: `트레일링 스톱 — 고점 ${p.highestPrice.toLocaleString()} 대비 -${dropPct.toFixed(2)}%`,
        });
        continue;
      }
    }

    // S2 순위 이탈 — v5.8 히스테리시스(이력 현상)
    //
    // v5.7 의 "현재순위 > 매수순위 → 즉시 매도" 는 시총 순위의 단일시점 노이즈(15→16위
    // 흔들림)에 매번 손절매 → 멀티 레짐 백테스트상 -188만원 출혈/회전율 폭증의 주범.
    //
    // v5.8: 모니터링 유니버스(Top 20) 밖으로 이탈 + EXIT_CONFIRM_TICKS 회 연속 확인돼야
    // 매도. buyRank 와 무관하게 "유니버스 이탈 확정" 만 본다. 이는 사용자 의도("10위권
    // 밖이라고 성급히 팔지 않기")와 정확히 일치. trailingActive(이익 +10% 도달)인 종목은
    // 트레일링 스톱이 우선 관리하므로 순위 매도에서 제외(승자 조기 청산 방지).
    {
      const currentRank = rankMap.get(p.ticker) ?? 999; // Top 30 밖이면 999
      const isOutside = currentRank > EXIT_RANK_THRESHOLD;
      const count = bumpOutOfUniverse(p.stock_id, isOutside, today);
      p.outOfUniverseCount = count;
      if (!p.trailingActive && isOutside && count >= EXIT_CONFIRM_TICKS) {
        decisions.push({
          position: p,
          reason: `순위 이탈 — Top ${EXIT_RANK_THRESHOLD} 밖 ${count}회 연속 (현재 ${currentRank >= 999 ? 'Top 30 밖' : currentRank + '위'})`,
        });
        continue;
      }
    }

    // S3 KOSPI 상승 + 수익 이익실현
    if (kospiChange !== null && kospiChange >= KOSPI_SELL_TRIGGER && p.profitPercent >= KOSPI_SELL_PROFIT_MIN) {
      decisions.push({
        position: p,
        reason: `KOSPI +${kospiChange}% + 수익 +${p.profitPercent}% — 이익실현`,
      });
      continue;
    }
  }

  return decisions;
}

interface BuyCandidate {
  stock: TopStock;
  reason: string;
}

/**
 * 매수 후보 산출. 시장 브레이크 / 죽는 시장은 외부에서 차단되므로 여기서는 후보만 정렬.
 * 우선순위: 미보유 Top 10 (시총 순) → 11~20위 상승 중 → 보유 재분배는 별도 단계.
 */
function evaluateBuyCandidates(
  topResult: BuildContextResult['topResult'],
  positions: Position[],
): BuyCandidate[] {
  const top10 = topResult.top10;
  const top20 = topResult.top20 ?? top10;
  const heldSet = new Set(positions.map((p) => p.ticker));
  const candidates: BuyCandidate[] = [];

  // B2 미보유 Top 10 — 시총 1위부터
  for (const s of top10) {
    if (heldSet.has(s.ticker)) continue;
    candidates.push({ stock: s, reason: `Top10 #${s.rank} 신규 진입` });
  }

  // B3 11~20위 상승 중
  for (const s of top20.slice(10)) {
    if (heldSet.has(s.ticker)) continue;
    if (isRankImproving(s.ticker, s.rank, RANK_IMPROVE_HOURS, RANK_IMPROVE_THRESHOLD)) {
      candidates.push({
        stock: s,
        reason: `#${s.rank} 상승 추세 (직전 ${RANK_IMPROVE_HOURS}h 대비 ${RANK_IMPROVE_THRESHOLD}+ 단계 상승)`,
      });
    }
  }

  return candidates;
}

/** 트레일링/순위/KOSPI 매도 실행. 결과 result 에 누적. */
async function executeSellDecisions(decisions: SellDecision[], result: RebalanceResult): Promise<void> {
  for (const d of decisions) {
    const { position: p, reason } = d;
    try {
      const r = await executeOrder({
        stockId: p.stock_id,
        ticker: p.ticker,
        market: 'KRX',
        orderType: 'SELL',
        quantity: p.qty,
        price: 0,
        reason,
      });
      if (r.success) {
        resetTrackingOnSell(p.stock_id);
        result.sold.push({ ticker: p.ticker, name: p.name, quantity: p.qty, reason });
        logger.info({ ticker: p.ticker, qty: p.qty, reason }, '[Rebal] SELL 체결');
      } else {
        result.skipped.push({ ticker: p.ticker, name: p.name, reason: `SELL 실패: ${r.message}` });
      }
    } catch (err) {
      result.skipped.push({ ticker: p.ticker, name: p.name, reason: `SELL 예외: ${(err as Error).message}` });
    }
  }
}

/**
 * 매수 후보 + 재분배 실행. 잔고 부족 시 다음 종목, 1주도 불가능하면 종료.
 */
async function executeBuyPhase(
  candidates: BuyCandidate[],
  positions: Position[],
  topResult: BuildContextResult['topResult'],
  result: RebalanceResult,
): Promise<void> {
  let cash = await getDomesticOrderableAmount().catch(() => 0);
  const top10 = topResult.top10;
  const top10Set = new Set(top10.map((s) => s.ticker));

  // 보유 수량 in-memory 추적 (재분배용)
  const holdingQty: Record<string, number> = {};
  for (const p of positions) {
    if (top10Set.has(p.ticker)) holdingQty[p.ticker] = p.qty;
  }
  const buyTally: Record<string, { name: string; qty: number; lastPrice: number; reason: string }> = {};

  const recordBuy = (s: TopStock, fillPrice: number, reason: string): void => {
    cash -= fillPrice;
    const e = buyTally[s.ticker] ?? { name: s.name, qty: 0, lastPrice: fillPrice, reason };
    e.qty += 1;
    e.lastPrice = fillPrice;
    buyTally[s.ticker] = e;
    holdingQty[s.ticker] = (holdingQty[s.ticker] ?? 0) + 1;
  };

  // B2 + B3 후보 매수
  for (const c of candidates) {
    const s = c.stock;
    if (s.closePrice <= 0) {
      result.skipped.push({ ticker: s.ticker, name: s.name, reason: '가격 정보 없음' });
      continue;
    }
    if (s.closePrice > cash) {
      result.skipped.push({
        ticker: s.ticker,
        name: s.name,
        reason: `1주(${s.closePrice.toLocaleString()}원) > 잔고(${cash.toLocaleString()}원)`,
      });
      continue;
    }
    try {
      const stockId = ensureStockId(s.ticker, s.name, s.market);
      const r = await executeOrder({
        stockId,
        ticker: s.ticker,
        market: 'KRX',
        orderType: 'BUY',
        quantity: 1,
        price: 0,
        reason: c.reason,
      });
      if (r.success) {
        recordBuy(s, r.price || s.closePrice, c.reason);
        upsertTrackingOnBuy(stockId, s.rank, r.price || s.closePrice);
        logger.info({ ticker: s.ticker, rank: s.rank, price: r.price, reason: c.reason }, '[Rebal] BUY 체결');
      } else {
        result.skipped.push({ ticker: s.ticker, name: s.name, reason: `BUY 실패: ${r.message}` });
      }
    } catch (err) {
      result.skipped.push({ ticker: s.ticker, name: s.name, reason: `BUY 예외: ${(err as Error).message}` });
    }
  }

  // B4 재분배 — 보유 Top 10 중 평가금액 최저부터
  for (let i = 0; i < REBAL_MAX_ITER; i++) {
    if (cash <= 0) break;
    const reCandidates = top10
      .filter((s) => (holdingQty[s.ticker] ?? 0) > 0 && s.closePrice > 0 && s.closePrice <= cash)
      .map((s) => ({ stock: s, evalAmt: (holdingQty[s.ticker] ?? 0) * s.closePrice }))
      .sort((a, b) => a.evalAmt - b.evalAmt);
    if (reCandidates.length === 0) break;
    const target = reCandidates[0].stock;
    try {
      const stockId = ensureStockId(target.ticker, target.name, target.market);
      const r = await executeOrder({
        stockId,
        ticker: target.ticker,
        market: 'KRX',
        orderType: 'BUY',
        quantity: 1,
        price: 0,
        reason: 'Top10 재분배 — 평가 최저',
      });
      if (r.success) {
        recordBuy(target, r.price || target.closePrice, '재분배');
        upsertTrackingOnBuy(stockId, target.rank, r.price || target.closePrice);
      } else {
        result.skipped.push({ ticker: target.ticker, name: target.name, reason: `재분배 BUY 실패: ${r.message}` });
        break;
      }
    } catch (err) {
      result.skipped.push({
        ticker: target.ticker,
        name: target.name,
        reason: `재분배 BUY 예외: ${(err as Error).message}`,
      });
      break;
    }
  }

  for (const [ticker, info] of Object.entries(buyTally)) {
    result.bought.push({ ticker, name: info.name, quantity: info.qty, price: info.lastPrice, reason: info.reason });
  }
}

/**
 * Rebalance 메인 진입점. mode:
 *   - 'normal' : 매시간 cron — 매도(S1/S2/S3) + 매수(B1-B4) 전체 평가
 *   - 'kospi-spike-sell-only' : 14:30 cron — KOSPI +4% 시 S3 만 평가 (매수 X)
 */
export async function runRebalanceStrategy(
  reason: string,
  mode: 'normal' | 'kospi-spike-sell-only' = 'normal',
): Promise<RebalanceResult> {
  const settings = getSettings();

  const result: RebalanceResult = {
    reason,
    fetchedAt: new Date().toISOString(),
    kospiChangePercent: null,
    top10Tickers: [],
    sold: [],
    bought: [],
    skipped: [],
    noop: true,
    mode,
  };

  if (!settings.autoTradeEnabled) {
    logger.info({ reason }, '[Rebal] autoTradeEnabled=false — dry-run');
    return result;
  }

  const ctx = await buildContext();
  result.fetchedAt = ctx.topResult.fetchedAt;
  result.top10Tickers = ctx.topResult.top10.map((s) => s.ticker);
  result.kospiChangePercent = ctx.kospiChange;

  // 14:30 special cron: KOSPI +4% 미만이면 noop (트리거 자체가 발동 안 함)
  if (mode === 'kospi-spike-sell-only') {
    if (ctx.kospiChange === null || ctx.kospiChange < KOSPI_SELL_TRIGGER) {
      logger.info({ kospi: ctx.kospiChange }, '[Rebal] 14:30 cron — KOSPI 스파이크 없음, skip');
      return result;
    }
  }

  // ───────── 매도 단계 ─────────
  const today = new Date().toISOString().slice(0, 10);
  const sellDecisions = evaluateSells(
    ctx.positions,
    ctx.topResult.topExtended ?? ctx.topResult.top10,
    ctx.kospiChange,
    mode,
    today,
  );
  await executeSellDecisions(sellDecisions, result);

  // KOSPI 스파이크 매도 전용 모드는 여기서 종료
  if (mode === 'kospi-spike-sell-only') {
    result.noop = result.sold.length === 0;
    if (!result.noop) {
      await logSystemEvent(
        'INFO',
        'GENERAL',
        `[Rebal] 14:30 스파이크 매도 — ${result.sold.length}건 (KOSPI +${ctx.kospiChange}%)`,
        JSON.stringify(result),
        '',
      );
    }
    return result;
  }

  // ───────── 매수 단계 ─────────
  const brake = await checkMarketBrake();
  const dying = await detectDyingMarket();
  if (brake.shouldBrake) {
    result.brakeReason = brake.reason;
    logger.info({ reason: brake.reason }, '[Rebal] marketBrake — 매수 차단');
  } else if (dying.isDying) {
    result.dyingMarketReason = dying.reason;
    logger.info({ reason: dying.reason }, '[Rebal] 죽는 시장 — 매수 차단 (보유 유지)');
  } else {
    // 매도 후 잔고 갱신을 위해 positions 다시 — 단 잔고는 executeBuyPhase 내부에서 KIS 재조회
    const refreshedPositions = ctx.positions.filter(
      (p) => !sellDecisions.find((d) => d.position.stock_id === p.stock_id),
    );
    const buyCandidates = evaluateBuyCandidates(ctx.topResult, refreshedPositions);
    if (ctx.kospiChange !== null && ctx.kospiChange <= KOSPI_BUY_TRIGGER) {
      logger.info(
        { kospi: ctx.kospiChange, candidates: buyCandidates.length },
        '[Rebal] KOSPI 급락 — 적극 매수 모드',
      );
    }
    await executeBuyPhase(buyCandidates, refreshedPositions, ctx.topResult, result);
  }

  result.noop = result.sold.length === 0 && result.bought.length === 0;
  if (!result.noop) {
    await logSystemEvent(
      'INFO',
      'GENERAL',
      `[Rebal] v5.7 — 매도 ${result.sold.length}건, 매수 ${result.bought.length}건 (${reason})`,
      JSON.stringify({
        kospi: ctx.kospiChange,
        sold: result.sold,
        bought: result.bought,
        skipped: result.skipped,
        brakeReason: result.brakeReason,
        dyingMarketReason: result.dyingMarketReason,
      }),
      '',
    );
  }
  return result;
}
