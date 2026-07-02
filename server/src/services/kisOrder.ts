/**
 * KIS 주문 API
 * - 국내주식: TTTC0802U (매수), TTTC0801U (매도)
 * - 모의투자: VTTC0802U, VTTC0801U
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { queryOne, queryAll, execute } from '../db';
import { kisApiCall } from './apiQueue';
import { createNotification } from './notification';
import {
  getKstSession, resolveExchange, isExtendedSession, priceMarketDiv,
  type Exchange,
} from './kisMarketHours';
import logger from '../logger';

/**
 * 한국 주식 호가 단위 (Tick Size) — 2023년 1월 이후 KOSPI/KOSDAQ 동일.
 * KIS API는 호가 단위 어긋난 주문을 APBK0506 으로 거부하므로 매수 가격을 반드시 보정해야 한다.
 *
 * v5.4까지 매수 100% 실패의 직접 원인 — 본 함수 부재로 currentPrice * 0.995 가
 * 호가 단위와 어긋난 가격이 그대로 KIS 에 제출됨 (예: SK텔레콤 106,664 → 100원 단위 미준수).
 */
export function roundDownToTick(price: number): number {
  if (price <= 0) return 0;
  let tick: number;
  if (price < 2_000)        tick = 1;
  else if (price < 5_000)   tick = 5;
  else if (price < 20_000)  tick = 10;
  else if (price < 50_000)  tick = 50;
  else if (price < 200_000) tick = 100;
  else if (price < 500_000) tick = 500;
  else                      tick = 1_000;
  return Math.floor(price / tick) * tick;
}

// ─── 타입 ─────────────────────────────────────────────

export interface OrderRequest {
  stockId: number;
  ticker: string;
  market: 'KRX';
  orderType: 'BUY' | 'SELL';
  quantity: number;
  price: number;        // 0이면 시장가
  reason?: string;      // 매수/매도 사유 (auto_trades.reason 기록용)
  /** v5.4.0 — BUY 시점 컨피던스 가중치 (1.0~1.5). sizing 보너스. */
  confidenceMultiplier?: number;
  /** v5.4.0 — SELL 시점 호가 호의적이면 지정가, 아니면 시장가. quote book 기반 동적 결정. */
  preferLimitOnSell?: boolean;
  /** v6.1.2 — 수동 주문(포트폴리오 화면 추가매수/매도). 자동매매 토글과 무관하게 실행하고
   *  거래내역 memo 를 '수동매매' 로 기록한다. */
  manual?: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: number;      // auto_trades.id
  kisOrderNo?: string;   // KIS 주문번호
  message: string;
  quantity: number;
  price: number;
  fee: number;
}

// v4.18.0: 구조화된 실패 사유 (auto_trades.failure_reason 컬럼에 기록)
// 기존 error_message 문자열 키워드 매칭 의존을 제거하고 enum-like 분류로 대체.
export type FailureReason =
  | 'SUSPENDED'          // 거래정지·상장폐지·정리매매 (APBK0066 등)
  | 'INSUFFICIENT_FUNDS' // 주문가능 금액 부족
  | 'QTY_EXCEEDED'       // 주문가능 수량 초과 (APBK0400) — 장부·실잔고 불일치 신호
  | 'WIDE_SPREAD'        // 호가 스프레드 과대
  | 'LOW_LIQUIDITY'      // 호가 깊이 부족
  | 'POSITION_LIMIT'     // 포지션 사이징 규칙 위반
  | 'QUOTE_FETCH_FAIL'   // 현재가 조회 실패
  | 'PROTECTION_BLOCKED' // Protection 차단
  | 'NETWORK'            // 타임아웃/네트워크
  | 'API_ERROR'          // KIS 응답 에러 (위 구조화 대상 외)
  | 'UNKNOWN';           // 분류 불가

/** KIS 에러 메시지를 FailureReason enum으로 분류.
 *  기존 레코드(failure_reason='' 또는 NULL)를 해석할 때 폴백으로 사용. */
export function classifyFailure(errorMessage: string): FailureReason {
  if (!errorMessage) return 'UNKNOWN';
  const m = errorMessage;
  if (/APBK0066|거래정지|매매정지|상장폐지|정리매매/.test(m)) return 'SUSPENDED';
  // APBK0400 "주문 가능한 수량을 초과했습니다" — DB 장부와 실잔고가 어긋났다는 신호.
  // INSUFFICIENT_FUNDS 의 /주문가능/ 보다 먼저 검사해야 한다 (수량 초과는 금액 부족이 아님).
  if (/APBK0400|주문 ?가능한 ?수량|매도 ?가능 ?수량/.test(m)) return 'QTY_EXCEEDED';
  if (/주문가능|잔고부족|현금부족|INSUFFICIENT/i.test(m)) return 'INSUFFICIENT_FUNDS';
  if (/스프레드/.test(m)) return 'WIDE_SPREAD';
  if (/호가 깊이|liquidity/i.test(m)) return 'LOW_LIQUIDITY';
  if (/포지션|position/i.test(m)) return 'POSITION_LIMIT';
  if (/현재가 조회 실패/.test(m)) return 'QUOTE_FETCH_FAIL';
  if (/Protection|차단/.test(m)) return 'PROTECTION_BLOCKED';
  if (/timeout|network|ECONNREFUSED/i.test(m)) return 'NETWORK';
  if (/^APBK|^msg_cd/.test(m)) return 'API_ERROR';
  return 'UNKNOWN';
}

/**
 * 주문 실패/거부 메시지를 사용자용 한글 안내로 변환 (수동 주문 알림용).
 * KIS 원문 메시지는 괄호로 함께 노출해 원인 추적이 가능하게 한다.
 */
export function friendlyOrderError(raw: string): string {
  const m = raw || '';
  if (/시간|장종료|장 ?종료|장개시|장 ?개시|운영시간|주문가능시간|영업일|개장|마감/.test(m)) {
    return `지금은 주문 가능 시간이 아닙니다.${raw ? ` (사유: ${raw})` : ''}`;
  }
  if (/호가|APBK0506|가격제한|상한가|하한가|단위|가격/.test(m)) {
    return `주문 가격이 유효하지 않습니다 — 호가 단위·가격제한폭을 확인하세요.${raw ? ` (사유: ${raw})` : ''}`;
  }
  if (/주문가능|잔고|현금부족|예수금|미수|INSUFFICIENT/i.test(m)) {
    return `주문가능 금액 또는 수량이 부족합니다.${raw ? ` (사유: ${raw})` : ''}`;
  }
  if (/거래정지|매매정지|상장폐지|정리매매|APBK0066/.test(m)) {
    return `거래정지·거래불가 종목입니다.${raw ? ` (사유: ${raw})` : ''}`;
  }
  if (/현재가 조회 실패/.test(m)) {
    return '현재가 조회에 실패했습니다. 잠시 후 다시 시도하세요.';
  }
  return raw || '주문을 처리할 수 없습니다.';
}

// ─── 현재가 조회 ──────────────────────────────────────

/** 국내주식 현재가 조회 — rate-limit 큐 경유 (v6.0.5: 직접 fetch 가 EGW00201 잔여 원인이었음).
 *  v6.1: mrktDiv 로 시장구분 선택 — 확장 세션엔 KRX+NXT 통합('UN'), 메인장엔 KRX('J'). */
async function getDomesticPrice(ticker: string, mrktDiv: 'J' | 'UN' = 'J'): Promise<number | null> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  const token = await getAccessToken();

  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: mrktDiv,
    fid_input_iscd: ticker,
  });

  const response = await kisApiCall(() => fetch(
    `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'FHKST01010100', custtype: 'P',
      },
    }
  ), `order-price-${ticker}`);

  if (!response.ok) return null;
  const data: any = await response.json();
  if (data.rt_cd !== '0') return null;
  return Number(data.output?.stck_prpr) || null;
}

/** 현재가 조회 — 확장 세션이면 통합('UN') 가, 그 외 KRX('J'). 'UN' 실패 시 'J' 폴백. */
export async function getCurrentPrice(ticker: string, _market: 'KRX'): Promise<number | null> {
  const session = getKstSession(new Date());
  const div = priceMarketDiv(session);
  const price = await getDomesticPrice(ticker, div);
  if (price !== null) return price;
  return div === 'UN' ? getDomesticPrice(ticker, 'J') : null; // 통합가 실패 시 KRX 폴백
}

// ─── 수수료 계산 ──────────────────────────────────────

function calculateFee(_market: string, amount: number): number {
  // KRX: 매매수수료 0.015% + 매도 시 세금 0.18% (간략화: 총 0.25%)
  return Math.round(amount * 0.0025);
}

/** 국내 매수가능금액 조회 (inquire-psbl-order, TTTC8908R) */
export async function getDomesticOrderableAmount(): Promise<number> {
  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    const settings = getSettings();
    const token = await getAccessToken();
    const trId = isVirtual ? 'VTTC8908R' : 'TTTC8908R';

    return await kisApiCall(async () => {
      const params = new URLSearchParams({
        CANO: settings.kisAccountNo,
        ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
        PDNO: '', // 빈값 = 전체
        ORD_UNPR: '0',
        ORD_DVSN: '01', // 시장가
        CMA_EVLU_AMT_ICLD_YN: 'Y',
        OVRS_ICLD_YN: 'N',
      });
      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-psbl-order?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: trId, custtype: 'P',
          },
        }
      );
      if (!response.ok) return 0;
      const data: any = await response.json();
      if (data.rt_cd !== '0') return 0;
      const output = data.output || {};
      // nrcvb_buy_amt: 미수없는매수금액 (실제 주문가능금액 — 담보 포함)
      // max_buy_amt: 최대매수금액
      // ord_psbl_cash: 주문가능현금 (현금만)
      const orderable = Number(output.nrcvb_buy_amt || output.max_buy_amt || output.ord_psbl_cash || 0);
      logger.debug({ nrcvb: output.nrcvb_buy_amt, max: output.max_buy_amt, cash: output.ord_psbl_cash, orderable }, 'KIS orderable amount');
      return orderable;
    }, 'orderable-domestic');
  } catch {
    return 0;
  }
}

// ─── 매도 수량 가드 (장부 ↔ 실잔고 불일치 방어) ────────
//
// 배경(삼성전자 사건, 2026-06-12~07-02): DB 장부가 유령 매수로 9주까지 부풀려진
// 상태에서 실잔고 4주 계좌에 SELL 9 를 매시간 반복 제출 → KIS 가 APBK0400 으로
// 전량 거부 → 익절·트레일링 스톱이 3주간 한 번도 실행되지 못하고 +13% 수익이
// 마이너스로 방치됨. 매도는 반드시 실잔고를 상한으로 캡한다.

export interface SellQuantityGuard {
  quantity: number;   // 실제 제출할 수량
  clamped: boolean;   // 장부 > 실잔고 → 축소됨 (불일치 감지 신호)
  blocked: boolean;   // 실잔고 0 → 주문 불가
}

/**
 * 매도 수량 결정 — min(장부 수량, KIS 실잔고). 순수 함수 (단위 테스트 대상).
 * kisQty=null(조회 실패)이면 원 수량 유지: 일시 조회 장애로 트레일링 스톱이
 * 멈추면 안 되므로 차단하지 않고 KIS 를 최종 판정자로 둔다.
 */
export function resolveSellQuantity(requested: number, kisQty: number | null): SellQuantityGuard {
  if (kisQty === null) return { quantity: requested, clamped: false, blocked: false };
  if (kisQty <= 0) return { quantity: 0, clamped: true, blocked: true };
  if (requested > kisQty) return { quantity: kisQty, clamped: true, blocked: false };
  return { quantity: requested, clamped: false, blocked: false };
}

/** KIS 실계좌의 해당 종목 보유 수량. 잔고 조회 실패 시 null(가드 미적용). */
async function getKisHoldingQty(ticker: string): Promise<number | null> {
  try {
    // 동적 import — kisBalance 가 본 모듈(getDomesticOrderableAmount)을 import 하므로
    // 정적 import 시 순환 참조가 된다.
    const { getKisBalance } = await import('./kisBalance');
    const balance = await getKisBalance();
    if (!balance || balance.stale) return null;
    const holding = balance.holdings.find((h) => h.ticker === ticker);
    return holding ? holding.quantity : 0; // 잔고 정상 조회 + 종목 없음 = 실보유 0
  } catch {
    return null;
  }
}

/** 같은 (type, ticker) 알림을 KST 기준 하루 1회로 제한 — 매시간 cron 스팸 방지. */
function notifyOncePerDay(type: string, ticker: string, title: string, message: string): void {
  try {
    const exists = queryOne(
      `SELECT id FROM notifications
       WHERE type = ? AND ticker = ?
         AND date(created_at, '+9 hours') = date('now', '+9 hours')
       LIMIT 1`,
      [type, ticker],
    );
    if (exists) return;
    createNotification({ type, title, message, ticker });
  } catch (err) {
    logger.error({ err, type, ticker }, 'notifyOncePerDay failed');
  }
}

// 불일치 감지 시 자동 재동기화 — 반복 실패가 KIS 호출 폭주로 번지지 않게 최소 간격 유지.
let lastAutoReconcileAt = 0;
const AUTO_RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 장부·실잔고 불일치 감지 시 복구: 알림(일 1회) + KIS 잔고 강제 재동기화(10분 debounce).
 * fire-and-forget — 주문 흐름을 막지 않는다.
 */
function triggerQtyMismatchRecovery(ticker: string, detail: string): void {
  // 알림 type 은 연속 실패 알림(TRADE_FAILURE_STREAK)과 분리 — 같은 type 을 쓰면
  // 하루 1회 dedup 이 서로를 가려 한쪽 알림이 침묵한다 (알림 침묵이 이번 사건의 본질).
  notifyOncePerDay(
    'TRADE_FAILURE_QTY_MISMATCH',
    ticker,
    `매도 수량 불일치 감지: ${ticker}`,
    `장부 수량과 KIS 실잔고가 다릅니다 — ${detail}\n잔고 자동 재동기화를 실행합니다. 포트폴리오 화면에서 보유 수량을 확인하세요.`,
  );
  const now = Date.now();
  if (now - lastAutoReconcileAt < AUTO_RECONCILE_MIN_INTERVAL_MS) return;
  lastAutoReconcileAt = now;
  import('./balanceSync')
    .then(({ syncKisBalance }) => syncKisBalance('불일치 자동 동기화'))
    .then((r) => logger.info({ ticker, ok: r.ok, message: r.message }, 'qty-mismatch auto reconcile'))
    .catch((err) => logger.error({ err, ticker }, 'qty-mismatch auto reconcile failed'));
}

/** 최근 매도 시도 중 마지막 성공 이후 연속 FAILED 횟수 (최대 10건 조회). */
export function countConsecutiveSellFailures(stockId: number): number {
  const rows = queryAll<{ status: string }>(
    `SELECT status FROM auto_trades
     WHERE stock_id = ? AND order_type = 'SELL' AND status IN ('FILLED', 'FAILED')
     ORDER BY id DESC LIMIT 10`,
    [stockId],
  );
  let n = 0;
  for (const r of rows) {
    if (r.status !== 'FAILED') break;
    n += 1;
  }
  return n;
}

// ─── 리스크 체크 ──────────────────────────────────────

interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * v5.2: 단순화 — autoTradeEnabled 체크만.
 * 일일 거래 횟수 / 총 투자한도는 KIS 잔고 기반 자동 분할로 대체.
 */
export function checkRiskLimits(_orderType: 'BUY' | 'SELL', _amount: number): RiskCheckResult {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    return { allowed: false, reason: '자동매매 비활성화' };
  }
  return { allowed: true };
}

// ─── 국내주식 주문 ────────────────────────────────────

export async function submitDomesticOrder(
  ticker: string,
  orderType: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  exchange: Exchange = 'KRX',
): Promise<{ success: boolean; orderNo: string; message: string }> {
  const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
  const settings = getSettings();
  const token = await getAccessToken();

  // 매수: TTTC0802U, 매도: TTTC0801U (모의: VTTC*)
  const trId = orderType === 'BUY'
    ? (isVirtual ? 'VTTC0802U' : 'TTTC0802U')
    : (isVirtual ? 'VTTC0801U' : 'TTTC0801U');

  // 주문유형: 00=지정가, 01=시장가
  const ordType = price > 0 ? '00' : '01';

  // v6.1 거래소 라우팅 — KRX 외(SOR/NXT) 일 때만 EXCG_ID_DVSN_CD 부착.
  // 모의투자(VTTC*)는 NXT 미지원이라 항상 KRX 로 강제.
  const exchangeCode: Exchange = isVirtual ? 'KRX' : exchange;
  const body = {
    CANO: settings.kisAccountNo,
    ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
    PDNO: ticker,
    ORD_DVSN: ordType,
    ORD_QTY: String(quantity),
    ORD_UNPR: price > 0 ? String(price) : '0',
    ...(exchangeCode !== 'KRX' ? { EXCG_ID_DVSN_CD: exchangeCode } : {}),
  };

  const data: any = await kisApiCall(async () => {
    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/trading/order-cash`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
        body: JSON.stringify(body),
      }
    );
    return response.json();
  }, `order-domestic-${orderType}-${ticker}`);

  if (data.rt_cd === '0') {
    return {
      success: true,
      orderNo: data.output?.ODNO || data.output?.KRX_FWDG_ORD_ORGNO || '',
      message: data.msg1 || '주문 성공',
    };
  }

  return {
    success: false,
    orderNo: '',
    message: `${data.msg_cd}: ${data.msg1 || '주문 실패'}`,
  };
}

// ─── 주문 취소 / 정정 ─────────────────────────────────

/**
 * KIS 미체결 주문 취소 (orderChase에서 stale 주문 갱신용).
 * Endpoint: /uapi/domestic-stock/v1/trading/order-rvsecncl
 * TR_ID: TTTC0803U (실전), VTTC0803U (모의)
 */
export async function cancelKisOrder(orderNo: string, ticker: string, quantity: number): Promise<{ success: boolean; message: string }> {
  if (!orderNo) return { success: false, message: '주문번호 없음' };

  const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
  const settings = getSettings();
  const token = await getAccessToken();
  const trId = isVirtual ? 'VTTC0803U' : 'TTTC0803U';

  const body = {
    CANO: settings.kisAccountNo,
    ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
    KRX_FWDG_ORD_ORGNO: '',  // 빈 문자열이면 KIS가 ODNO로 자동 매핑
    ORGN_ODNO: orderNo,
    ORD_DVSN: '00',
    RVSE_CNCL_DVSN_CD: '02', // 02 = 취소
    ORD_QTY: String(quantity),
    ORD_UNPR: '0',
    QTY_ALL_ORD_YN: 'Y',
    PDNO: ticker,
  };

  try {
    const data: any = await kisApiCall(async () => {
      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/trading/order-rvsecncl`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: trId, custtype: 'P',
          },
          body: JSON.stringify(body),
        }
      );
      return response.json();
    }, `cancel-${orderNo}`);

    if (data.rt_cd === '0') {
      return { success: true, message: data.msg1 || '취소 성공' };
    }
    return { success: false, message: `${data.msg_cd}: ${data.msg1 || '취소 실패'}` };
  } catch (err) {
    return { success: false, message: (err as Error).message };
  }
}

/**
 * 미체결 주문을 새 가격으로 재제출 (cancel + new submit).
 * @param newPrice 0이면 시장가, 양수면 지정가
 */
export async function resubmitOrder(args: {
  oldOrderNo: string;
  ticker: string;
  orderType: 'BUY' | 'SELL';
  quantity: number;
  newPrice: number;
}): Promise<{ success: boolean; orderNo: string; message: string }> {
  const cancel = await cancelKisOrder(args.oldOrderNo, args.ticker, args.quantity);
  if (!cancel.success) {
    // 취소 실패는 보통 "이미 체결됨" 의미 — chase 종료 신호
    return { success: false, orderNo: '', message: `취소 실패: ${cancel.message}` };
  }
  // 약간의 지연 후 재제출 (KIS 큐 정리)
  await new Promise(r => setTimeout(r, 200));
  return submitDomesticOrder(args.ticker, args.orderType, args.quantity, args.newPrice);
}

// ─── 통합 주문 실행 ───────────────────────────────────

/** 당일 거래정지/매매불가 이력 체크.
 *  v4.18.0: 구조화된 failure_reason='SUSPENDED' 우선 조회.
 *  기존 레코드(failure_reason='')는 error_message 키워드 매칭으로 폴백.
 *
 *  export 이유: UC-07 단위 테스트를 위한 공개.
 */
export function isSuspendedToday(stockId: number): { suspended: boolean; reason?: string } {
  const row = queryOne(
    `SELECT error_message, failure_reason FROM auto_trades
     WHERE stock_id = ?
       AND status = 'FAILED'
       -- v6.0.7: "당일" = KST 거래일. created_at 은 UTC(CURRENT_TIMESTAMP) 저장이라
       -- date('now')(UTC) 비교 시 KST 09:00(UTC 자정)에 날짜가 갈려 오전 정지 이력이
       -- 9시에 풀리는 버그가 있었음 → +9h 보정으로 KST 달력일 비교.
       AND date(created_at, '+9 hours') = date('now', '+9 hours')
       AND (
         failure_reason = 'SUSPENDED'
         OR error_message LIKE '%APBK0066%'
         OR error_message LIKE '%거래정지%'
         OR error_message LIKE '%매매정지%'
         OR error_message LIKE '%상장폐지%'
         OR error_message LIKE '%정리매매%'
       )
     ORDER BY created_at DESC LIMIT 1`,
    [stockId]
  );
  if (row) return { suspended: true, reason: row.error_message };
  return { suspended: false };
}

/** 주문 실행 (리스크 체크 → 현재가 조회 → 수량 계산 → 주문 제출 → DB 기록) */
export async function executeOrder(req: OrderRequest): Promise<OrderResult> {
  const settings = getSettings();

  // 0. 당일 거래정지 이력 차단 — 같은 종목에 대한 동일 에러 반복을 방지.
  //    수동 주문(req.manual)은 사용자가 직접 낸 주문이므로 이 로컬 가드를 건너뛰고
  //    KIS 응답을 최종 판정으로 삼는다(실제 거래정지면 KIS 가 거부 → friendlyOrderError 안내).
  const suspended = !req.manual ? isSuspendedToday(req.stockId) : { suspended: false as const };
  if (suspended.suspended) {
    try {
      const { logSystemEvent } = await import('./systemEvent');
      await logSystemEvent(
        'INFO',
        'TRADE_BLOCKED',
        `주문 차단 (당일 거래정지 종목): ${req.ticker}`,
        `오늘 동일 종목에서 거래정지성 실패 이력 발견 — 재시도 차단\n사유: ${suspended.reason ?? ''}`,
        req.ticker
      );
    } catch {}
    return {
      success: false,
      message: `거래정지 종목 — 당일 재시도 차단 (${suspended.reason ?? ''})`,
      quantity: 0,
      price: 0,
      fee: 0,
    };
  }

  // v6.1 세션/거래소 결정. 확장 세션(프리/애프터마켓)엔 KRX 휴장이라 시장가가 거부/위험 →
  // 무조건 지정가(통합가 기준). 메인장은 기존 동작 유지.
  const session = getKstSession(new Date());
  const exchange = resolveExchange(session, settings.nxtTradingEnabled);
  const extended = isExtendedSession(session) && settings.nxtTradingEnabled;

  // 1. 현재가 조회 + 스마트 가격 결정 (확장 세션은 통합가)
  const currentPrice = await getCurrentPrice(req.ticker, req.market);
  if (!currentPrice) {
    return { success: false, message: '현재가 조회 실패', quantity: 0, price: 0, fee: 0 };
  }

  let orderPrice = req.price;
  let useMarketOrder = false;

  if (orderPrice <= 0) {
    if (req.orderType === 'BUY') {
      // 매수: (메인) 현재가 -0.5% 지정가 / (확장) 통합 현재가 그대로 — 얇은 호가에서 체결 우선
      orderPrice = roundDownToTick(extended ? currentPrice : currentPrice * 0.995);
    } else {
      // 매도: (메인) 시장가 / (확장) 통합 현재가 지정가 — NXT 확장세션은 시장가 미지원
      orderPrice = currentPrice;
      useMarketOrder = !extended;
      if (extended) orderPrice = roundDownToTick(currentPrice);
    }
  } else if (req.orderType === 'BUY') {
    // 외부에서 가격 명시 시에도 호가 단위 보정
    orderPrice = roundDownToTick(orderPrice);
  }

  // 2. 매수 시: 가용 현금 안전망 (Top10 전략은 호출 시 quantity=1 명시)
  let quantity = req.quantity;

  // 2-0. 매도 시: KIS 실잔고 상한 캡 — 장부가 부풀어도 실잔고만큼은 반드시 팔린다.
  //     (수동 주문 포함 — 사용자도 장부 오류로 초과 매도 주문을 낼 수 있음)
  if (req.orderType === 'SELL') {
    const kisQty = await getKisHoldingQty(req.ticker);
    const guard = resolveSellQuantity(quantity, kisQty);
    if (guard.blocked) {
      logger.error({ ticker: req.ticker, requested: quantity, kisQty }, 'SELL blocked — KIS 실잔고 0');
      triggerQtyMismatchRecovery(req.ticker, `장부 ${quantity}주 / 실잔고 0주 — 매도 차단`);
      return {
        success: false,
        message: `KIS 실잔고 0 — 매도 불가 (장부 ${quantity}주와 불일치, 잔고 자동 재동기화 실행)`,
        quantity: 0,
        price: orderPrice,
        fee: 0,
      };
    }
    if (guard.clamped) {
      logger.warn(
        { ticker: req.ticker, requested: quantity, kisQty, submitted: guard.quantity },
        'SELL quantity clamped to KIS holding',
      );
      triggerQtyMismatchRecovery(req.ticker, `장부 ${quantity}주 → 실잔고 ${guard.quantity}주로 축소 제출`);
    }
    quantity = guard.quantity;
  }

  if (req.orderType === 'BUY') {
    const cashAmount = await getDomesticOrderableAmount().catch(() => 0);
    if (cashAmount <= 0) {
      return { success: false, message: '주문가능금액 0 — KIS 잔고 확인 필요', quantity: 0, price: orderPrice, fee: 0 };
    }
    // quantity 미지정 시 가용현금 90% 한도로 최대 매수 수량 산정
    if (quantity <= 0) {
      quantity = Math.floor((cashAmount * 0.9) / orderPrice);
    }
    // 가용현금 90% 초과 시 차감
    if (orderPrice * quantity > cashAmount * 0.9) {
      quantity = Math.floor((cashAmount * 0.9) / orderPrice);
    }
  }

  if (quantity <= 0) {
    return { success: false, message: '주문 수량 0 — 주문가능금액 부족 또는 가격 대비 한도 부족', quantity: 0, price: orderPrice, fee: 0 };
  }

  // 3. 리스크 체크 — 수동 주문(req.manual)은 자동매매 토글과 무관하게 사용자가 직접 낸 주문이므로
  //    autoTradeEnabled 게이트를 건너뛴다.
  if (!req.manual) {
    const riskCheck = checkRiskLimits(req.orderType, orderPrice * quantity);
    if (!riskCheck.allowed) {
      return { success: false, message: riskCheck.reason!, quantity, price: orderPrice, fee: 0 };
    }
  }

  // 4. 수수료 계산
  const fee = calculateFee(req.market, orderPrice * quantity);

  // 5. auto_trades에 SUBMITTED 기록 (v5.0: signal_id 컬럼 제거)
  const { lastId: tradeId } = execute(
    'INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.stockId, req.orderType, quantity, orderPrice, fee, 'SUBMITTED', req.reason || ''],
  );

  // 6. KIS 주문 제출
  try {
    let result: { success: boolean; orderNo: string; message: string; filledQty?: number; filledPrice?: number };

    const submitPrice = useMarketOrder ? 0 : orderPrice;
    result = await submitDomesticOrder(req.ticker, req.orderType, quantity, submitPrice, exchange);

    if (result.success) {
      // 부분 체결 처리: KIS 응답에서 실제 체결 수량/가격 사용 (가능 시).
      // submitDomesticOrder는 ODNO만 반환하지만, 추후 inquire-ccnl로 체결 내역 조회 가능.
      // 단순화: filledQty 미제공 시 요청 수량 그대로 사용 (대부분 정상 체결).
      const finalQty = result.filledQty && result.filledQty > 0 ? result.filledQty : quantity;
      const finalPrice = result.filledPrice && result.filledPrice > 0 ? result.filledPrice : orderPrice;
      const finalFee = calculateFee(req.market, finalQty * finalPrice);

      execute(
        "UPDATE auto_trades SET status = 'FILLED', kis_order_no = ?, executed_at = datetime('now'), quantity = ?, price = ?, fee = ? WHERE id = ?",
        [result.orderNo, finalQty, finalPrice, finalFee, tradeId],
      );

      const today = new Date().toISOString().split('T')[0];
      // 수동 주문은 거래내역에서 '수동매매' 로 식별 (자동매매와 구분 — UI 배지/필터용)
      const memoPrefix = req.manual ? '수동매매' : '자동매매';
      execute(
        'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          req.stockId, req.orderType, finalQty, finalPrice, finalFee, today,
          `${memoPrefix} (KIS: ${result.orderNo})${req.reason ? ' / ' + req.reason : ''}`,
        ],
      );

      logger.info(
        { orderType: req.orderType, ticker: req.ticker, quantity: finalQty, price: finalPrice, orderNo: result.orderNo },
        'KIS order filled',
      );

      return {
        success: true,
        orderId: tradeId,
        kisOrderNo: result.orderNo,
        message: result.message,
        quantity: finalQty,
        price: finalPrice,
        fee: finalFee,
      };
    } else {
      // 주문 실패 — v4.18.0: failure_reason 구조화 기록
      const failureReason = classifyFailure(result.message);
      execute(
        "UPDATE auto_trades SET status = 'FAILED', error_message = ?, failure_reason = ? WHERE id = ?",
        [result.message, failureReason, tradeId]
      );

      logger.error({ orderType: req.orderType, ticker: req.ticker, message: result.message, failureReason }, 'KIS order failed');

      // APBK0400(수량 초과) = 사전 캡을 통과했는데도 실잔고와 어긋남 → 즉시 재동기화 + 알림.
      // 삼성전자 사건에서는 이 에러가 120여 회 반복되는 동안 아무 조치가 없었다.
      if (failureReason === 'QTY_EXCEEDED') {
        triggerQtyMismatchRecovery(req.ticker, `KIS 거부: ${result.message}`);
      }

      // 같은 종목 매도가 연속으로 계속 실패하면 원인과 무관하게 사용자에게 알린다
      // (익절/손절이 실행되지 않고 있다는 뜻 — 방치가 가장 큰 손실).
      if (req.orderType === 'SELL' && countConsecutiveSellFailures(req.stockId) >= 3) {
        notifyOncePerDay(
          'TRADE_FAILURE_STREAK',
          req.ticker,
          `매도 연속 실패: ${req.ticker}`,
          `매도 주문이 3회 이상 연속 실패하고 있습니다. 익절·손절이 실행되지 않는 상태입니다.\n최근 사유: ${result.message}`,
        );
      }

      return {
        success: false,
        orderId: tradeId,
        message: result.message,
        quantity,
        price: orderPrice,
        fee,
      };
    }
  } catch (err: any) {
    // 네트워크/예외 경로 — 대부분 NETWORK 또는 UNKNOWN
    const failureReason = classifyFailure(err.message || '');
    execute(
      "UPDATE auto_trades SET status = 'FAILED', error_message = ?, failure_reason = ? WHERE id = ?",
      [err.message, failureReason, tradeId]
    );

    return {
      success: false,
      orderId: tradeId,
      message: err.message,
      quantity,
      price: orderPrice,
      fee,
    };
  }
}

// getHoldingQuantity(raw SUM 방식) 는 v6.1.3 에서 제거 — 사용처가 없었고,
// 엔진(positionAverage.getPositionQuantity)과 다른 세 번째 잔고 계산식이었다.
// 보유 수량이 필요하면 positionAverage 의 fold 계산을 단일 소스로 사용할 것.

// ─── 주문 상태 조회 ───────────────────────────────────

/** 오늘의 자동매매 기록 조회 */
export function getTodayAutoTrades(): any[] {
  return queryAll(
    "SELECT at.*, s.ticker, s.name FROM auto_trades at JOIN stocks s ON s.id = at.stock_id WHERE date(at.created_at, '+9 hours') = date('now', '+9 hours') ORDER BY at.created_at DESC"
  );
}

/** PENDING 상태 주문 조회 */
export function getPendingOrders(): any[] {
  return queryAll(
    "SELECT at.*, s.ticker, s.name, s.market FROM auto_trades at JOIN stocks s ON s.id = at.stock_id WHERE at.status = 'PENDING' ORDER BY at.created_at"
  );
}
