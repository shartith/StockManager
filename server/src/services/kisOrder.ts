/**
 * KIS 주문 API
 * - 국내주식: TTTC0802U (매수), TTTC0801U (매도)
 * - 모의투자: VTTC0802U, VTTC0801U
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { queryOne, queryAll, execute } from '../db';
import { kisApiCall } from './apiQueue';
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

// ─── 현재가 조회 ──────────────────────────────────────

/** 국내주식 현재가 조회 */
async function getDomesticPrice(ticker: string): Promise<number | null> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  const token = await getAccessToken();

  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J',
    fid_input_iscd: ticker,
  });

  const response = await fetch(
    `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'FHKST01010100', custtype: 'P',
      },
    }
  );

  if (!response.ok) return null;
  const data: any = await response.json();
  if (data.rt_cd !== '0') return null;
  return Number(data.output?.stck_prpr) || null;
}

/** KRX 현재가 조회 */
export async function getCurrentPrice(ticker: string, _market: 'KRX'): Promise<number | null> {
  return getDomesticPrice(ticker);
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

  const body = {
    CANO: settings.kisAccountNo,
    ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
    PDNO: ticker,
    ORD_DVSN: ordType,
    ORD_QTY: String(quantity),
    ORD_UNPR: price > 0 ? String(price) : '0',
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
       AND date(created_at) = date('now')
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

  // 0. 당일 거래정지 이력 차단 — 같은 종목에 대한 동일 에러 반복을 방지
  const suspended = isSuspendedToday(req.stockId);
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

  // 1. 현재가 조회 + 스마트 가격 결정
  const currentPrice = await getCurrentPrice(req.ticker, req.market);
  if (!currentPrice) {
    return { success: false, message: '현재가 조회 실패', quantity: 0, price: 0, fee: 0 };
  }

  let orderPrice = req.price;
  let useMarketOrder = false;

  if (orderPrice <= 0) {
    if (req.orderType === 'BUY') {
      // 매수: 현재가 -0.5% 지정가 + 호가 단위 보정 (v5.6.1 — APBK0506 거부 방지)
      orderPrice = roundDownToTick(currentPrice * 0.995);
    } else {
      // 매도: 시장가 (Top10 이탈 즉시 정리)
      orderPrice = currentPrice;
      useMarketOrder = true;
    }
  } else if (req.orderType === 'BUY') {
    // 외부에서 가격 명시 시에도 호가 단위 보정
    orderPrice = roundDownToTick(orderPrice);
  }

  // 2. 매수 시: 가용 현금 안전망 (Top10 전략은 호출 시 quantity=1 명시)
  let quantity = req.quantity;
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

  // 3. 리스크 체크
  const riskCheck = checkRiskLimits(req.orderType, orderPrice * quantity);
  if (!riskCheck.allowed) {
    return { success: false, message: riskCheck.reason!, quantity, price: orderPrice, fee: 0 };
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
    result = await submitDomesticOrder(req.ticker, req.orderType, quantity, submitPrice);

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
      execute(
        'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          req.stockId, req.orderType, finalQty, finalPrice, finalFee, today,
          `자동매매 (KIS: ${result.orderNo})${req.reason ? ' / ' + req.reason : ''}`,
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

// ─── 보유 수량 조회 ───────────────────────────────────

/** 특정 종목의 보유 수량 조회 */
export function getHoldingQuantity(stockId: number): number {
  const row = queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type='SELL' THEN t.quantity ELSE 0 END), 0) as qty
    FROM transactions t WHERE t.stock_id = ?
  `, [stockId]);
  return row?.qty || 0;
}

// ─── 주문 상태 조회 ───────────────────────────────────

/** 오늘의 자동매매 기록 조회 */
export function getTodayAutoTrades(): any[] {
  return queryAll(
    "SELECT at.*, s.ticker, s.name FROM auto_trades at JOIN stocks s ON s.id = at.stock_id WHERE date(at.created_at) = date('now') ORDER BY at.created_at DESC"
  );
}

/** PENDING 상태 주문 조회 */
export function getPendingOrders(): any[] {
  return queryAll(
    "SELECT at.*, s.ticker, s.name, s.market FROM auto_trades at JOIN stocks s ON s.id = at.stock_id WHERE at.status = 'PENDING' ORDER BY at.created_at"
  );
}
