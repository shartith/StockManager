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

import { fetchTop10, isRankImproving, persistRankHistory, type TopStock } from './topMarketCap';
import { getPositionAverages } from './positionAverage';
import { getKisBalance } from './kisBalance';
import { getSettings } from './settings';
import { executeOrder, getDomesticOrderableAmount } from './kisOrder';
import { checkMarketBrake } from './marketBrake';
import { getKospiDailyChange, detectDyingMarket, getKospiRegime } from './marketSignals';
import { fetchMomentumScores, rankByMomentum } from './momentumRank';
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
// v6.1.2: 트레일링 활성률/하락폭은 설정값(settings.trailingActivatePercent /
//   trailingStopDropPercent)으로 노출. 아래는 설정 미지정 시 폴백 기본값(백테스트 확정치).
const DEFAULT_TRAILING_ACTIVATION_PCT = 10; // 수익 +10% 도달 시 트레일링 활성화
const DEFAULT_TRAILING_STOP_DROP_PCT = 2;   // 활성 후 고점 대비 -2% 시 매도 (백테스트상 유지가 최선)
const KOSPI_BUY_TRIGGER = -4;       // KOSPI -4% 이하: 적극 매수 모드 (현재는 marketBrake 와 별도 로깅만)
const KOSPI_SELL_TRIGGER = 4;       // KOSPI +4% 이상: 이익 실현 매도 트리거
const KOSPI_SELL_PROFIT_MIN = 5;    // 위 트리거 시 매도 대상은 +5% 이상 수익 종목
const RANK_IMPROVE_HOURS = 24;      // "직전 24h 대비"
const RANK_IMPROVE_THRESHOLD = 2;   // 2단계 이상 상승해야 매수 후보
// v6.1.4: 미보유 Top10(B2) 급등 우선매수 — 09:00~14:29 1분 간격 폴링으로 "최근 N분간
// 꺾이지 않고 계속 오른" 종목만 확인해 시총순위와 무관하게 매수 큐 맨 앞으로 당긴다
// (evaluateBuyCandidates/isSteadyRiser 참고). 단발 스파이크 한 틱만 보고 사는 상투매수를
// 피하려고 지속성(연속 상승)을 요구한다. MAX 는 추가 안전판 — 이미 너무 오른 종목은
// 우선 버킷에서 제외하고 일반 순서(끝순위)로 미룬다.
//
// 실측 검증(scripts/analyze-minute-patterns.mjs, 최근 6거래일 Top25 종목 급등일 20건):
// 이 기준으로 급등일의 90%(18/20)를 확인했고, 확인 후 평균 +5.47% 추가 상승 vs 평균
// -2.31% 되돌림(비율 약 2.4:1) — "이미 많이 올랐으면 하락하지 않겠나"는 우려와 달리
// 확인 시점(평균 +1.29%)이 아직 초반이라 유리했다. 확인 시각 분포에서 09:30~09:59
// 구간이 전체 확인 사례의 1/3을 차지 — 이 구간이 비어 있던 게 놓친 원인이었다.
const SPIKE_CONFIRM_SAMPLES = 5;    // 최근 5분(=5개 1분 샘플) 연속 상승해야 확인
const SPIKE_MIN_RISE_PCT = 1.5;     // 그 5분 동안 최소 이만큼 올라야 함(평평한 노이즈 배제)
const SPIKE_BUY_THRESHOLD_PCT = 3;  // 오늘 등락률 최소 바닥 — 이 이상이어야 급등 버킷 진입
const SPIKE_BUY_MAX_PCT = 8;        // 이미 너무 오른 종목은 상투 위험으로 우선순위에서 제외

// v6.1.4: 급등 확인 매수 후보가 있는데 현금이 모자를 때, 소액 손실 보유종목을 팔아
// 현금을 확보하는 기회적 스왑매도(executeBuyPhase/trySwapSellForCash 참고). "손실
// 비율이 아니라 손실 금액이 작은" 종목부터 고르되(사용자 요청), 시총(현재 랭킹)이
// 급등 후보보다 나쁜 종목만 교체 대상으로 삼는다. 이 값은 안전판 — 손실률이 아무리
// 작아도 너무 크게 물린 종목까지 정리하지 않도록 상한을 둔다.
const SWAP_SELL_MAX_LOSS_PCT = 5;
// v5.8.0 순위 이탈 매도 — 히스테리시스(이력 현상)
const EXIT_RANK_THRESHOLD = 20;     // 모니터링 유니버스(Top 20) 밖으로 이탈해야 매도 후보
// 연속 N "거래일" 이탈 확인돼야 실제 매도 (노이즈 필터) — nextOutOfUniverseState 가
// lastOutDate 로 거래일 단위 dedup 하므로 cron 이 얼마나 자주 돌아도 의미는 그대로 "N거래일".
const EXIT_CONFIRM_TICKS = 2;
// v6.0.3 순위 이탈 매도의 "안 봐도 되는 손해" 방지 (8개 연도 백테스트로 확정):
//   · 손실 바닥: -8% 초과 손실 종목은 순위이탈로 팔지 않음(손실 확정 회피, 회복 대기).
//     급락 패닉으로 일시 순위 이탈한 종목을 바닥에 던지는 것을 막는다.
//     → 8년 기하평균 14.7%→16.8%/년, 특히 반등장(2023·2024) 대폭 개선.
//   · 급락장 정지: 마켓 브레이크/죽는시장(패닉일)엔 순위 매도 자체를 정지(순위가 노이즈).
const RANK_EXIT_MAX_LOSS = 8;       // 이 % 초과 손실이면 순위이탈 매도 보류 (트레일링/회복에 위임)
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
  dryRun?: boolean;            // 자동매매 OFF — 실제 주문 없이 의도만 기록(관찰)
  mode?: 'normal' | 'kospi-spike-sell-only'; // 14:30 special cron
}

interface PositionRow {
  stock_id: number;
  ticker: string;
  name: string;
  market: string;
  qty: number;
  avg_price: number;
  locked: boolean;  // 거래 고정 — 자동매매 매도/재분배 제외 (장기 보유 보호)
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
  const rows = queryAll<{
    stock_id: number; ticker: string; name: string; market: string; locked: number;
  }>(`
    SELECT DISTINCT s.id as stock_id, s.ticker, s.name, COALESCE(s.market, 'KRX') as market,
           COALESCE(s.locked, 0) as locked
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
  `);

  // v6.0.4: 평단을 KIS 방식 이동평균(매도 시 불변, 전량 매도 시 리셋)으로 계산.
  // 이전 "전체 기간 매수 평균"은 매도분이 평단을 오염시켜 profitPercent 가 틀어지고
  // → 트레일링 활성/손실바닥 판정까지 어긋났음 (화면 표시 + 매매 판정 양쪽 버그).
  const positions = getPositionAverages();

  return rows
    .map((r) => {
      const pos = positions.get(r.stock_id);
      return pos && pos.quantity > 0
        ? {
            stock_id: r.stock_id, ticker: r.ticker, name: r.name, market: r.market,
            locked: !!r.locked, qty: pos.quantity, avg_price: pos.avgPrice,
          }
        : null;
    })
    .filter((r): r is PositionRow => r !== null);
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
 * v6.0.3 순위이탈 매도 보류 판정 — 순수 함수 (단위 테스트 대상).
 *
 * "안 봐도 되는 손해"(급락 패닉 바닥/큰 손실 확정) 방지:
 *   - marketStressed(급락/죽는시장): 순위가 노이즈 → 매도 보류
 *   - profitPercent < -maxLoss: 큰 손실 종목은 순위이탈로 던지지 않음(회복/트레일링에 위임)
 * 8개 연도 백테스트로 검증 (기하평균 14.7%→16.8%/년).
 */
export function shouldPauseRankExit(
  profitPercent: number,
  marketStressed: boolean,
  maxLoss: number,
): boolean {
  return marketStressed || profitPercent < -maxLoss;
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

/**
 * v6.0: selectionMode==='momentum' 이면 시총 유니버스(Top 30)를 가격 모멘텀으로 재랭킹.
 * 시총 순위를 모멘텀 순위로 교체하므로 하위 매수/매도 로직은 변경 없이 그대로 동작.
 * 모멘텀 점수 조회 실패 시 시총 순서 그대로 폴백(전략이 멈추지 않음).
 */
// 모멘텀 점수가 이 수보다 적으면(Yahoo 대량 실패) 시총 순위로 폴백 — 희소 모멘텀으로
// 무의미한 종목을 Top 10 에 넣는 사고 방지.
const MIN_MOMENTUM_SCORES = 15;

async function applyMomentumRanking(
  topResult: Awaited<ReturnType<typeof fetchTop10>>,
): Promise<Awaited<ReturnType<typeof fetchTop10>>> {
  const universe = topResult.topExtended ?? topResult.top10; // 시총 Top 30
  const scores = await fetchMomentumScores(universe);
  if (scores.size < MIN_MOMENTUM_SCORES) {
    logger.warn({ scored: scores.size, need: MIN_MOMENTUM_SCORES }, '[Rebal] 모멘텀 점수 부족 — 시총 순위 폴백');
    return topResult;
  }
  const reranked = rankByMomentum(universe, scores);
  return {
    ...topResult,
    topExtended: reranked,
    top20: reranked.slice(0, 20),
    top10: reranked.slice(0, 10),
  };
}

async function buildContext(): Promise<BuildContextResult> {
  const settings = getSettings();
  let topResult = await fetchTop10(true);
  if (settings.selectionMode === 'momentum') {
    topResult = await applyMomentumRanking(topResult);
  }
  // v6.0: 유효 순위(시총 또는 모멘텀)를 rank_history 에 기록 — isRankImproving(B3)이
  //       항상 같은 기준끼리 비교되도록. (fetchTop10 에서 이관)
  try {
    persistRankHistory(topResult.topExtended ?? topResult.top10);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[Rebal] persistRankHistory failed');
  }

  // v6.1.4: 등락률 샘플 버퍼 갱신 — evaluateBuyCandidates 의 급등 확인(isSteadyRiser)이
  // 이 버퍼로 판단한다. Top10 뿐 아니라 Top30(topExtended)까지 갱신해 B3 상승세
  // 판단권 종목도 향후 B2 진입 시 이미 데이터가 쌓여 있도록 한다.
  resetFluctBuffersIfNewDay(new Date().toISOString().slice(0, 10));
  for (const s of topResult.topExtended ?? topResult.top10) {
    const buf = fluctBuffers.get(s.ticker) ?? [];
    buf.push(s.fluctuationsRatio);
    if (buf.length > SPIKE_CONFIRM_SAMPLES) buf.shift();
    fluctBuffers.set(s.ticker, buf);
  }

  const positionRows = getCurrentPositions();

  // v6.0.7 보유 종목 현재가 — KIS 실잔고(prpr, 장전 보정 포함)를 1순위로 사용.
  // 원칙: 현재가/평단/평가금은 어디서든 KIS 와 일치 — 화면(v6.0.4)뿐 아니라
  // 매매 판정(트레일링 활성/손실바닥의 profitPercent)도 같은 가격이어야 한다.
  // 이전 Yahoo 시세는 지연 가능성이 있어 화면과 엔진이 서로 다른 가격으로 움직였음.
  // KIS 미응답/미포함 종목만 Yahoo 폴백 (전략 무중단).
  const priceMap = new Map<string, number>();
  try {
    const kisBal = await getKisBalance();
    if (kisBal) {
      for (const h of kisBal.holdings) {
        if (h.currentPrice > 0) priceMap.set(h.ticker, h.currentPrice);
      }
    }
  } catch {
    /* 아래 Yahoo 폴백 */
  }
  const missingTickers = positionRows.map((p) => p.ticker).filter((t) => !priceMap.has(t));
  if (missingTickers.length > 0) {
    const yahooFallback = await fetchPriceMap(missingTickers);
    for (const [t, price] of yahooFallback) priceMap.set(t, price);
    logger.warn({ tickers: missingTickers }, '[Rebal] KIS 시세 누락 — Yahoo 폴백 사용');
  }

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
  marketStressed: boolean,
  trailingActivatePct: number,
  trailingStopDropPct: number,
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
    if (!p.trailingActive && p.profitPercent >= trailingActivatePct) {
      activateTrailing(p.stock_id);
      p.trailingActive = true;
    }

    // 거래 고정(잠금) 종목 — 자동매매 매도 대상에서 제외 (장기 보유 보호).
    // 트래킹(최고가/트레일링 활성)은 위에서 갱신해 두되, 어떤 매도 룰(S1/S2/S3)도 평가하지 않는다.
    if (p.locked) continue;

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
      if (dropPct >= trailingStopDropPct) {
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
    // 밖이라고 성급히 팔지 않기")와 정확히 일치. trailingActive(설정 활성 수익률 도달)인 종목은
    // 트레일링 스톱이 우선 관리하므로 순위 매도에서 제외(승자 조기 청산 방지).
    // v6.0.3 "안 봐도 되는 손해" 방지 — 두 경우엔 순위이탈 매도를 보류:
    //   (a) 급락 패닉일(marketStressed): 순위가 노이즈라 바닥에 던지지 않음
    //   (b) 큰 손실(-RANK_EXIT_MAX_LOSS 초과): 손실 확정 회피, 회복/트레일링에 위임
    // 보류 시 히스테리시스 카운트도 건드리지 않아(증가/리셋 X), 안정된 날에만 회전.
    if (!shouldPauseRankExit(p.profitPercent, marketStressed, RANK_EXIT_MAX_LOSS)) {
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
  /** v6.1.4: true면 연속상승 확인된 급등 매수 후보 — 현금 부족 시 스왑매도 시도 대상. */
  spiking: boolean;
}

/**
 * 매수 후보 산출. 시장 브레이크 / 죽는 시장은 외부에서 차단되므로 여기서는 후보만 정렬.
 * 우선순위: 미보유 Top 10 (급등 버킷 우선 → 나머지 시총 순) → 11~20위 상승 중 →
 * 보유 재분배는 별도 단계.
 *
 * fluctBuffers: 09:00~14:29 1분 간격으로 buildContext 가 갱신하는 종목별 등락률
 * 샘플 버퍼(오래된 것부터) — isSteadyRiser 로 "연속 상승 확인"을 판단하는 데 쓴다.
 */
export function evaluateBuyCandidates(
  topResult: BuildContextResult['topResult'],
  positions: Position[],
  mode: 'marketcap' | 'momentum',
  fluctBuffers: ReadonlyMap<string, number[]>,
): BuyCandidate[] {
  const top10 = topResult.top10;
  const top20 = topResult.top20 ?? top10;
  const heldSet = new Set(positions.map((p) => p.ticker));
  const candidates: BuyCandidate[] = [];
  const label = mode === 'momentum' ? '모멘텀' : '시총';

  // B2 미보유 Top 10 — v6.1.4: 등락률이 [SPIKE_BUY_THRESHOLD_PCT, SPIKE_BUY_MAX_PCT]
  // 구간이면서 "연속 SPIKE_CONFIRM_SAMPLES분 상승 확인"(isSteadyRiser)된 종목을 먼저
  // 사고, 나머지는 기존 시총순위 그대로. 단발 스파이크 한 틱만 보고 사는 상투매수를
  // 막기 위해 지속성을 요구한다(실측 근거는 상수 선언부 주석 참고). 순위 그대로만
  // 사면 비싼 상위권에 현금이 먼저 소진돼 지금 급등 중인 8~10위 종목을 놓치는 문제
  // (사용자 리포트) 방지. 각 버킷 내부 순서는 원래 top10 배열 순서(=시총순위) 유지.
  const unheldTop10 = top10.filter((s) => !heldSet.has(s.ticker));
  const isSpiking = (s: TopStock) =>
    s.fluctuationsRatio >= SPIKE_BUY_THRESHOLD_PCT &&
    s.fluctuationsRatio <= SPIKE_BUY_MAX_PCT &&
    isSteadyRiser(fluctBuffers.get(s.ticker) ?? []);
  const spiking = unheldTop10.filter(isSpiking);
  const normal = unheldTop10.filter((s) => !isSpiking(s));
  for (const s of spiking) {
    candidates.push({
      stock: s,
      spiking: true,
      reason: `${label} Top10 #${s.rank} 급등 우선매수 (오늘 ${s.fluctuationsRatio >= 0 ? '+' : ''}${s.fluctuationsRatio.toFixed(2)}%, 최근 ${SPIKE_CONFIRM_SAMPLES}분 연속↑)`,
    });
  }
  for (const s of normal) {
    candidates.push({ stock: s, spiking: false, reason: `${label} Top10 #${s.rank} 신규 진입` });
  }

  // B3 11~20위 상승 중 (rank_history 는 buildContext 에서 유효순위로 기록되므로 동일 기준 비교)
  for (const s of top20.slice(10)) {
    if (heldSet.has(s.ticker)) continue;
    if (isRankImproving(s.ticker, s.rank, RANK_IMPROVE_HOURS, RANK_IMPROVE_THRESHOLD)) {
      candidates.push({
        stock: s,
        spiking: false,
        reason: `${label} #${s.rank} 상승 추세 (직전 ${RANK_IMPROVE_HOURS}h 대비 ${RANK_IMPROVE_THRESHOLD}+ 단계↑)`,
      });
    }
  }

  return candidates;
}

/** 트레일링/순위/KOSPI 매도 실행. dryRun 이면 실제 주문 없이 의도만 기록(관찰). */
async function executeSellDecisions(
  decisions: SellDecision[],
  result: RebalanceResult,
  dryRun: boolean,
): Promise<void> {
  for (const d of decisions) {
    const { position: p, reason } = d;
    if (dryRun) {
      // 관찰 모드: 실제 매도/트래킹 변경 없이 "팔 종목" 만 기록
      result.sold.push({ ticker: p.ticker, name: p.name, quantity: p.qty, reason: `[관찰] ${reason}` });
      logger.info({ ticker: p.ticker, qty: p.qty, reason }, '[Rebal] (dry-run) SELL 예정');
      continue;
    }
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
        // r.quantity: 실제 제출·체결 수량 — 실잔고 캡으로 장부(p.qty)보다 적을 수 있음
        result.sold.push({ ticker: p.ticker, name: p.name, quantity: r.quantity, reason });
        logger.info({ ticker: p.ticker, qty: r.quantity, requested: p.qty, reason }, '[Rebal] SELL 체결');
      } else {
        result.skipped.push({ ticker: p.ticker, name: p.name, reason: `SELL 실패: ${r.message}` });
      }
    } catch (err) {
      result.skipped.push({ ticker: p.ticker, name: p.name, reason: `SELL 예외: ${(err as Error).message}` });
    }
  }
}

interface SwapSellTarget {
  position: Position;
  lossAmount: number;  // 음수 = 손실 (원)
  lossPercent: number; // 음수 = 손실 (%)
}

/**
 * 급등 확인 매수 후보를 위해 팔 만한 "소액 손실" 보유종목을 찾는다(순수 로직).
 * 우선순위: 손실 금액이 가장 작은(0에 가까운) 것부터 — "손실 비율이 아니라 손실
 * 금액이 적은 종목부터" 사용자 요청 반영. 두 가지 안전판:
 *   (1) 손실률이 SWAP_SELL_MAX_LOSS_PCT 를 넘는 종목은 대상에서 제외 — 손실액이
 *       작아 보여도(소량 보유) 크게 물린 종목까지 정리하지 않도록.
 *   (2) 시총(현재 랭킹) 비교 — 후보보다 랭킹이 같거나 나쁜(숫자가 큰) 종목만 교체
 *       대상. 더 좋은 종목을 팔아 못한 종목을 사는 걸 막는다("시총 비교해서 판단"
 *       사용자 요청). 랭킹 밖(Top30 이탈)인 보유종목은 999로 취급해 항상 대상.
 */
export function findSwapSellTarget(
  positions: readonly Position[],
  lockedSet: ReadonlySet<string>,
  rankMap: ReadonlyMap<string, number>,
  candidateRank: number,
  excludeTickers: ReadonlySet<string>,
): SwapSellTarget | null {
  const losers = positions
    .filter((p) => !lockedSet.has(p.ticker) && !excludeTickers.has(p.ticker))
    .map((p) => {
      const lossAmount = (p.currentPrice - p.avg_price) * p.qty;
      const lossPercent = p.avg_price > 0 ? ((p.currentPrice - p.avg_price) / p.avg_price) * 100 : 0;
      const heldRank = rankMap.get(p.ticker) ?? 999;
      return { position: p, lossAmount, lossPercent, heldRank };
    })
    .filter((x) => x.lossAmount < 0)
    .filter((x) => x.lossPercent >= -SWAP_SELL_MAX_LOSS_PCT)
    .filter((x) => x.heldRank >= candidateRank)
    .sort((a, b) => b.lossAmount - a.lossAmount); // 손실액이 작은(덜 마이너스인) 것부터

  const top = losers[0];
  return top ? { position: top.position, lossAmount: top.lossAmount, lossPercent: top.lossPercent } : null;
}

/**
 * 급등 매수 후보인데 현금이 모자를 때, 소액 손실 보유종목 1개를 팔아 현금을 확보한다.
 * dryRun 이면 실제 주문 없이 관찰 기록만. 갱신된 cash 를 반환(대상 없거나 실패 시 원래 cash).
 */
async function trySwapSellForCash(
  candidate: TopStock,
  cash: number,
  positions: readonly Position[],
  lockedSet: ReadonlySet<string>,
  rankMap: ReadonlyMap<string, number>,
  swappedTickers: Set<string>,
  result: RebalanceResult,
  dryRun: boolean,
): Promise<number> {
  const swap = findSwapSellTarget(positions, lockedSet, rankMap, candidate.rank, swappedTickers);
  if (!swap) return cash;

  const lossLabel = `${Math.round(swap.lossAmount).toLocaleString()}원`;
  const reason = `급등 매수(${candidate.ticker}) 재원 확보 — 소액손실(${lossLabel}) 스왑매도`;

  if (dryRun) {
    result.sold.push({
      ticker: swap.position.ticker, name: swap.position.name, quantity: swap.position.qty,
      reason: `[관찰] ${reason}`,
    });
    swappedTickers.add(swap.position.ticker);
    return cash + swap.position.currentPrice * swap.position.qty;
  }

  try {
    const r = await executeOrder({
      stockId: swap.position.stock_id,
      ticker: swap.position.ticker,
      market: 'KRX',
      orderType: 'SELL',
      quantity: swap.position.qty,
      price: 0,
      reason,
    });
    if (r.success) {
      resetTrackingOnSell(swap.position.stock_id);
      result.sold.push({ ticker: swap.position.ticker, name: swap.position.name, quantity: r.quantity, reason });
      swappedTickers.add(swap.position.ticker);
      logger.info(
        { ticker: swap.position.ticker, lossAmount: swap.lossAmount, forCandidate: candidate.ticker },
        '[Rebal] 스왑매도 체결',
      );
      return cash + (r.price || swap.position.currentPrice) * r.quantity;
    }
    result.skipped.push({ ticker: swap.position.ticker, name: swap.position.name, reason: `스왑매도 실패: ${r.message}` });
  } catch (err) {
    logger.warn({ err: (err as Error).message, ticker: swap.position.ticker }, '[Rebal] 스왑매도 예외');
  }
  return cash;
}

/**
 * 매수 후보 + 재분배 실행. 잔고 부족 시 다음 종목, 1주도 불가능하면 종료.
 */
async function executeBuyPhase(
  candidates: BuyCandidate[],
  positions: Position[],
  topResult: BuildContextResult['topResult'],
  result: RebalanceResult,
  dryRun: boolean,
): Promise<void> {
  let cash = await getDomesticOrderableAmount().catch(() => 0);
  const top10 = topResult.top10;
  const top10Set = new Set(top10.map((s) => s.ticker));
  const rankMap = new Map<string, number>();
  for (const s of topResult.topExtended ?? top10) rankMap.set(s.ticker, s.rank);

  // 보유 수량 in-memory 추적 (재분배용)
  const holdingQty: Record<string, number> = {};
  for (const p of positions) {
    if (top10Set.has(p.ticker)) holdingQty[p.ticker] = p.qty;
  }
  // 거래 고정 종목 — 재분배(추가 매수) 대상에서도 제외해 보유 수량을 그대로 동결
  const lockedSet = new Set(positions.filter((p) => p.locked).map((p) => p.ticker));
  // v6.1.4: 급등 매수 재원 확보를 위해 이번 사이클에 스왑매도한 종목 — 같은 종목을
  // 두 번 팔지 않도록, B4 재분배 대상에서도 제외되도록 추적.
  const swappedTickers = new Set<string>();
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
    if (s.closePrice > cash && c.spiking) {
      // 급등 확인 후보만 스왑매도 대상 — 일반(비급등) 후보는 그냥 현금 부족으로 스킵.
      cash = await trySwapSellForCash(s, cash, positions, lockedSet, rankMap, swappedTickers, result, dryRun);
    }
    if (s.closePrice > cash) {
      result.skipped.push({
        ticker: s.ticker,
        name: s.name,
        reason: `1주(${s.closePrice.toLocaleString()}원) > 잔고(${cash.toLocaleString()}원)`,
      });
      continue;
    }
    if (dryRun) {
      // 관찰 모드: 실제 주문/DB insert 없이 in-memory 로만 cash 차감 + 매수 예정 기록
      recordBuy(s, s.closePrice, `[관찰] ${c.reason}`);
      logger.info({ ticker: s.ticker, rank: s.rank, price: s.closePrice, reason: c.reason }, '[Rebal] (dry-run) BUY 예정');
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
      .filter((s) => (holdingQty[s.ticker] ?? 0) > 0 && !lockedSet.has(s.ticker) && !swappedTickers.has(s.ticker) && s.closePrice > 0 && s.closePrice <= cash)
      .map((s) => ({ stock: s, evalAmt: (holdingQty[s.ticker] ?? 0) * s.closePrice }))
      .sort((a, b) => a.evalAmt - b.evalAmt);
    if (reCandidates.length === 0) break;
    const target = reCandidates[0].stock;
    if (dryRun) {
      recordBuy(target, target.closePrice, '[관찰] 재분배');
      continue;
    }
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

// v6.1.4: 09:00~14:29 1분 간격 연속 폴링으로 이전 실행이 안 끝난 채 다음 tick과
// 겹쳐 같은 종목을 이중 매수/매도할 위험이 생겼다. runRebalanceStrategy 의 유일한
// 진입점이 이 플래그를 체크해 재진입을 막는다(cron·수동 API 공통 보호).
let rebalanceRunning = false;

// ─────────────────────────────────────────────────────────────
// v6.1.4: 종목별 등락률 샘플 버퍼 — "연속 상승 확인"(isSteadyRiser)의 데이터 소스.
// ─────────────────────────────────────────────────────────────
// 처음엔 09:00~09:29 전용 별도 함수(runMorningSpikeWatch)였으나, 1분봉 실측 분석
// (scripts/analyze-minute-patterns.mjs) 결과 확인 가능한 급등의 1/3이 09:30~09:59
// 구간에서 일어나는데 그 구간이 스케줄 공백이었던 게 드러나 — 09:00~14:29 전체를
// 1분 간격으로 통일하고, 버퍼도 하루 종일 이어지는 단일 메커니즘으로 합쳤다.
// buildContext() 가 매 사이클 갱신하고, evaluateBuyCandidates() 가 읽어서 판단한다.

let fluctWatchDate = '';
let fluctBuffers = new Map<string, number[]>(); // ticker -> 최근 등락률 샘플(오래된 것부터)

function resetFluctBuffersIfNewDay(today: string): void {
  if (fluctWatchDate !== today) {
    fluctWatchDate = today;
    fluctBuffers = new Map();
  }
}

/**
 * 최근 등락률 샘플(오래된 것부터)이 "꺾이지 않고 계속 상승"했는지 판정하는 순수 로직.
 * 조건: (1) 샘플이 SPIKE_CONFIRM_SAMPLES 개 이상 쌓였고, (2) 최근 구간에서 한 번도
 * 이전 샘플보다 낮아지지 않았으며, (3) 그 구간의 총 상승폭이 SPIKE_MIN_RISE_PCT 이상.
 */
export function isSteadyRiser(samples: readonly number[]): boolean {
  if (samples.length < SPIKE_CONFIRM_SAMPLES) return false;
  const recent = samples.slice(-SPIKE_CONFIRM_SAMPLES);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] < recent[i - 1]) return false; // 한 번이라도 꺾이면 탈락
  }
  const rise = recent[recent.length - 1] - recent[0];
  return rise >= SPIKE_MIN_RISE_PCT;
}

/**
 * Rebalance 메인 진입점. mode:
 *   - 'normal' : 5분 간격 cron — 매도(S1/S2/S3) + 매수(B1-B4) 전체 평가
 *   - 'kospi-spike-sell-only' : 14:30 cron — KOSPI +4% 시 S3 만 평가 (매수 X)
 *
 * cron뿐 아니라 수동 rebalance API(routes/topMarketCap.ts POST /rebalance)도 이 함수를
 * 거치므로, 재진입 가드를 여기 한 곳에 두면 모든 진입 경로가 함께 보호된다.
 */
export async function runRebalanceStrategy(
  reason: string,
  mode: 'normal' | 'kospi-spike-sell-only' = 'normal',
): Promise<RebalanceResult> {
  if (rebalanceRunning) {
    logger.warn({ reason, mode }, '[Rebal] 이전 실행이 아직 진행 중 — 이번 tick skip (재진입 방지)');
    return {
      reason: `${reason} (skip: 이전 실행 진행 중)`,
      fetchedAt: new Date().toISOString(),
      kospiChangePercent: null,
      top10Tickers: [],
      sold: [],
      bought: [],
      skipped: [],
      noop: true,
      mode,
    };
  }
  rebalanceRunning = true;
  try {
    return await runRebalanceStrategyInner(reason, mode);
  } finally {
    rebalanceRunning = false;
  }
}

async function runRebalanceStrategyInner(
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

  // 자동매매 OFF = 관찰(dry-run) 모드 — 의사결정은 계산/기록하되 실제 주문은 내지 않음.
  // (이전: 즉시 return 으로 아무것도 안 함 → 모멘텀 전환 전 관찰 불가했음)
  const dryRun = !settings.autoTradeEnabled;
  result.dryRun = dryRun;

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

  // 시장 스트레스(급락/죽는시장) 1회 평가 — 매도(순위이탈 정지)·매수(차단) 양쪽에 재사용.
  // v6.0.3: 매도 단계보다 먼저 평가해야 패닉일 순위이탈 매도를 정지할 수 있다.
  const brake = await checkMarketBrake();
  const dying = await detectDyingMarket();
  const marketStressed = brake.shouldBrake || dying.isDying;

  // ───────── 매도 단계 ─────────
  const today = new Date().toISOString().slice(0, 10);
  const sellDecisions = evaluateSells(
    ctx.positions,
    ctx.topResult.topExtended ?? ctx.topResult.top10,
    ctx.kospiChange,
    mode,
    today,
    marketStressed,
    settings.trailingActivatePercent ?? DEFAULT_TRAILING_ACTIVATION_PCT,
    settings.trailingStopDropPercent ?? DEFAULT_TRAILING_STOP_DROP_PCT,
  );
  await executeSellDecisions(sellDecisions, result, dryRun);

  // KOSPI 스파이크 매도 전용 모드는 여기서 종료
  if (mode === 'kospi-spike-sell-only') {
    result.noop = result.sold.length === 0;
    if (!result.noop) {
      await logSystemEvent(
        'INFO',
        'GENERAL',
        `[Rebal] 14:30 스파이크 매도${dryRun ? '(관찰)' : ''} — ${result.sold.length}건 (KOSPI +${ctx.kospiChange}%)`,
        JSON.stringify(result),
        '',
      );
    }
    return result;
  }

  // ───────── 매수 단계 ───────── (brake/dying 은 위에서 1회 평가됨)
  // v6.0 200일선 레짐 필터 (settings 토글) — 약세장이면 신규 매수 중단, 보유는 유지
  const regime = settings.regimeFilterEnabled ? await getKospiRegime() : null;
  const regimeOff = !!regime?.belowMa200;
  if (brake.shouldBrake) {
    result.brakeReason = brake.reason;
    logger.info({ reason: brake.reason }, '[Rebal] marketBrake — 매수 차단');
  } else if (dying.isDying) {
    result.dyingMarketReason = dying.reason;
    logger.info({ reason: dying.reason }, '[Rebal] 죽는 시장 — 매수 차단 (보유 유지)');
  } else if (regimeOff) {
    result.dyingMarketReason = `200일선 약세장 (KOSPI ${regime!.price.toFixed(0)} < MA200 ${regime!.ma200.toFixed(0)})`;
    logger.info({ price: regime!.price, ma200: regime!.ma200 }, '[Rebal] 200일선 레짐 필터 — 매수 차단 (보유 유지)');
  } else {
    // 매도 후 잔고 갱신을 위해 positions 다시 — 단 잔고는 executeBuyPhase 내부에서 KIS 재조회
    const refreshedPositions = ctx.positions.filter(
      (p) => !sellDecisions.find((d) => d.position.stock_id === p.stock_id),
    );
    const buyCandidates = evaluateBuyCandidates(ctx.topResult, refreshedPositions, settings.selectionMode, fluctBuffers);
    if (ctx.kospiChange !== null && ctx.kospiChange <= KOSPI_BUY_TRIGGER) {
      logger.info(
        { kospi: ctx.kospiChange, candidates: buyCandidates.length },
        '[Rebal] KOSPI 급락 — 적극 매수 모드',
      );
    }
    await executeBuyPhase(buyCandidates, refreshedPositions, ctx.topResult, result, dryRun);
  }

  result.noop = result.sold.length === 0 && result.bought.length === 0;
  if (!result.noop) {
    await logSystemEvent(
      'INFO',
      'GENERAL',
      `[Rebal]${dryRun ? '(관찰)' : ''} ${settings.selectionMode === 'momentum' ? '모멘텀' : '시총'} — 매도 ${result.sold.length}건, 매수 ${result.bought.length}건 (${reason})`,
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
