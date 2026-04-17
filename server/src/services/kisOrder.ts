/**
 * KIS 주문 API
 * - 국내주식: TTTC0802U (매수), TTTC0801U (매도)
 * - 해외주식: JTTT1002U (매수), JTTT1006U (매도)
 * - 모의투자: VTTC0802U, VTTC0801U (국내) / VTTT1002U, VTTT1001U (해외)
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { queryOne, queryAll, execute } from '../db';
import { kisApiCall } from './apiQueue';
import { calculateOptimalQuantity, checkPositionSizingRules } from './portfolioManager';
import logger from '../logger';

// ─── 타입 ─────────────────────────────────────────────

export interface OrderRequest {
  stockId: number;
  ticker: string;
  market: 'KRX' | 'NYSE' | 'NASDAQ';
  orderType: 'BUY' | 'SELL';
  quantity: number;
  price: number;        // 0이면 시장가
  signalId?: number;
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

/** 해외주식 현재가 조회 */
async function getOverseasPrice(ticker: string, market: 'NYSE' | 'NASDAQ'): Promise<number | null> {
  const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
  const token = await getAccessToken();
  const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
  const trId = isVirtual ? 'VHHDFS76200200' : 'HHDFS76200200';

  const params = new URLSearchParams({
    AUTH: '', EXCD: exchCode, SYMB: ticker,
  });

  const response = await fetch(
    `${baseUrl}/uapi/overseas-price/v1/quotations/price-detail?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: trId, custtype: 'P',
      },
    }
  );

  if (!response.ok) return null;
  const data: any = await response.json();
  if (data.rt_cd !== '0') return null;
  return Number(data.output?.last) || null;
}

/** 시장에 맞는 현재가 조회 */
export async function getCurrentPrice(ticker: string, market: 'KRX' | 'NYSE' | 'NASDAQ'): Promise<number | null> {
  if (market === 'KRX') return getDomesticPrice(ticker);
  return getOverseasPrice(ticker, market);
}

// ─── 수수료 계산 ──────────────────────────────────────

function calculateFee(market: string, amount: number): number {
  if (market === 'KRX') {
    // 국내: 매매수수료 0.015% + 매도 시 세금 0.18% (간략화: 총 0.25%)
    return Math.round(amount * 0.0025);
  }
  // 해외: 약 0.25% (환전 수수료 포함)
  return Math.round(amount * 0.0025 * 100) / 100;
}

// ─── 주문 수량 계산 ───────────────────────────────────

/** 투자 한도 내에서 주문 수량 계산 */
export function calculateOrderQuantity(
  price: number,
  market: string,
  maxPerStock: number,
  splitRatio: number = 100,
): number {
  if (price <= 0) return 0;
  const maxAmount = maxPerStock * (splitRatio / 100);
  const quantity = Math.floor(maxAmount / price);
  return Math.max(quantity, 1);
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

export function checkRiskLimits(orderType: 'BUY' | 'SELL', amount: number): RiskCheckResult {
  const settings = getSettings();

  if (!settings.autoTradeEnabled) {
    return { allowed: false, reason: '자동매매 비활성화' };
  }

  // 일일 거래 횟수 체크
  const todayTrades = queryOne(
    "SELECT COUNT(*) as cnt FROM auto_trades WHERE date(created_at) = date('now') AND status IN ('SUBMITTED', 'FILLED')"
  );
  if ((todayTrades?.cnt ?? 0) >= settings.autoTradeMaxDailyTrades) {
    return { allowed: false, reason: `일일 최대 거래 횟수(${settings.autoTradeMaxDailyTrades}회) 도달` };
  }

  if (orderType === 'BUY') {
    // 총 투자금액 체크
    const totalInvested = queryOne(
      "SELECT COALESCE(SUM(quantity * price), 0) as total FROM auto_trades WHERE order_type = 'BUY' AND status = 'FILLED' AND date(created_at) = date('now')"
    );
    if ((totalInvested?.total ?? 0) + amount > settings.autoTradeMaxInvestment) {
      return { allowed: false, reason: `총 투자한도(${settings.autoTradeMaxInvestment.toLocaleString()}원) 초과` };
    }
  }

  return { allowed: true };
}

// ─── 국내주식 주문 ────────────────────────────────────

async function submitDomesticOrder(
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

// ─── 해외주식 주문 ────────────────────────────────────

async function submitOverseasOrder(
  ticker: string,
  market: 'NYSE' | 'NASDAQ',
  orderType: 'BUY' | 'SELL',
  quantity: number,
  price: number,
): Promise<{ success: boolean; orderNo: string; message: string }> {
  const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
  const settings = getSettings();
  const token = await getAccessToken();

  const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
  // 실전: JTTT1002U(매수), JTTT1006U(매도) | 모의: VTTT1002U(매수), VTTT1001U(매도)
  const trId = orderType === 'BUY'
    ? (isVirtual ? 'VTTT1002U' : 'JTTT1002U')
    : (isVirtual ? 'VTTT1001U' : 'JTTT1006U');

  // 해외주식 주문유형: 00=지정가, 32=시장가(LOO)
  const ordType = price > 0 ? '00' : '32';

  const body = {
    CANO: settings.kisAccountNo,
    ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
    OVRS_EXCG_CD: exchCode,
    PDNO: ticker,
    ORD_DVSN: ordType,
    ORD_QTY: String(quantity),
    OVRS_ORD_UNPR: price > 0 ? String(price) : '0',
    ORD_SVR_DVSN_CD: '0',
  };

  const data: any = await kisApiCall(async () => {
    const response = await fetch(
      `${baseUrl}/uapi/overseas-stock/v1/trading/order`,
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
  }, `order-overseas-${orderType}-${ticker}`);

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

// ─── 통합 주문 실행 ───────────────────────────────────

/** 당일 거래정지/매매불가 이력 체크 — 오늘 자 auto_trades에서 해당 종목이
 *  거래정지성 에러(APBK0066 등)로 실패했으면 추가 주문 차단.
 *  키워드: '거래정지', '매매정지', '상장폐지', '정리매매' 등 영구성 에러 메시지.
 */
function isSuspendedToday(stockId: number): { suspended: boolean; reason?: string } {
  const row = queryOne(
    `SELECT error_message FROM auto_trades
     WHERE stock_id = ?
       AND status = 'FAILED'
       AND date(created_at) = date('now')
       AND (
         error_message LIKE '%APBK0066%'
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

  // 0-a. Protection 시스템 (v4.16.0) — StoplossGuard/CooldownPeriod/LowProfitPairs
  // 전략 수준 circuit breaker. 개별 주문 차단보다 먼저 평가해 전략 실패 조기 감지.
  try {
    const { checkProtections, logProtectionBlock } = await import('./protections');
    const protectionCtx = {
      stockId: req.stockId,
      ticker: req.ticker,
      market: req.market,
      orderType: req.orderType,
    };
    const protectionResult = checkProtections(protectionCtx);
    if (!protectionResult.allowed) {
      await logProtectionBlock(protectionCtx, protectionResult);
      return {
        success: false,
        message: protectionResult.reason ?? 'Protection 차단',
        quantity: 0,
        price: 0,
        fee: 0,
      };
    }
  } catch (err) {
    logger.error({ err, ticker: req.ticker }, 'Protection check failed — proceeding with order');
  }

  // 0-b. 당일 거래정지 이력 차단 — 같은 종목에 대한 동일 에러 반복을 방지
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
      // 매수: 현재가 -0.5% 지정가 (슬리피지 감소)
      orderPrice = req.market === 'KRX'
        ? Math.floor(currentPrice * 0.995)  // KRX: 정수
        : Math.round(currentPrice * 0.995 * 100) / 100;  // 해외: 소수점 2자리
    } else {
      // 매도: 시장가 (빠른 체결 우선)
      orderPrice = currentPrice;
      useMarketOrder = true;
    }
  }

  // 2. 매수 시: 포지션 사이징 + 주문가능금액 확인 + 수량 계산
  let quantity = req.quantity;
  if (req.orderType === 'BUY') {
    // 2a. 포지션 사이징 규칙 (예산/종목 수/현금 비율 gate)
    // 해외 종목: USD 가격을 KRW로 환산해야 totalValue/cash와 단위가 일치
    let fxRate = 1;
    if (req.market !== 'KRX') {
      try {
        const { getMarketContext } = await import('./stockPrice');
        const ctx = await getMarketContext();
        fxRate = ctx.usdKrw?.price ?? 1400; // fallback: 평균치
      } catch { fxRate = 1400; }
    }
    const sizing = checkPositionSizingRules(orderPrice, req.market, fxRate);
    if (!sizing.allowed) {
      // v4.11.0: 체결 차단 사유를 system_events에 기록 (Dashboard에서 확인 가능)
      try {
        const { logSystemEvent } = await import('./systemEvent');
        await logSystemEvent('INFO', 'TRADE_BLOCKED',
          `매수 차단 (포지션 규칙): ${req.ticker}`,
          sizing.reason ?? '', req.ticker);
      } catch {}
      return { success: false, message: `포지션 규칙: ${sizing.reason}`, quantity: 0, price: orderPrice, fee: 0 };
    }

    // 2b. 실제 주문가능금액 조회 (dnca_tot_amt가 아닌 ord_psbl_cash)
    let orderableAmount = settings.autoTradeMaxPerStock;
    try {
      if (req.market === 'KRX') {
        const available = await getDomesticOrderableAmount();
        if (available > 0) orderableAmount = Math.min(orderableAmount, available);
      }
      // 해외는 fetchOverseasDeposit에서 이미 처리됨
    } catch {}

    if (quantity <= 0) {
      // Use portfolio-based optimal quantity (respects max % per stock)
      const optimalQty = calculateOptimalQuantity(orderPrice, req.market);
      quantity = optimalQty > 0 ? optimalQty : calculateOrderQuantity(orderPrice, req.market, orderableAmount);
      // Ensure within available capital
      if (orderableAmount > 0 && quantity * orderPrice > orderableAmount) {
        quantity = Math.floor(orderableAmount / orderPrice);
      }
    }

    // 2c. 포지션 사이징 수량 상한 적용
    if (sizing.maxBuyQuantity > 0 && quantity > sizing.maxBuyQuantity) {
      quantity = sizing.maxBuyQuantity;
    }

    // 2d. 주문가능금액 대비 재검증
    const orderAmount = orderPrice * quantity;
    if (orderableAmount > 0 && orderAmount > orderableAmount) {
      quantity = Math.floor(orderableAmount / orderPrice);
    }
  }

  if (quantity <= 0) {
    return { success: false, message: '주문 수량 0 — 주문가능금액 부족 또는 가격 대비 한도 부족', quantity: 0, price: orderPrice, fee: 0 };
  }

  // 2.5. 호가 품질 최후 방어선 (매수 주문 한정, KRX만)
  if (req.orderType === 'BUY' && req.market === 'KRX') {
    try {
      const { getQuoteBook } = await import('./quoteBook');
      const { logSystemEvent } = await import('./systemEvent');
      const qb = await getQuoteBook(req.ticker, req.market);
      if (qb) {
        const orderValue = orderPrice * quantity;
        // 호가 깊이가 주문금액의 2배 미만이면 취소 (슬리피지 과도)
        if (qb.topBookDepthKrw < orderValue * 2) {
          await logSystemEvent('WARN', 'LOW_LIQUIDITY',
            `매수 주문 취소 — 호가 깊이 부족`,
            `depth ${qb.topBookDepthKrw.toLocaleString()}원 < 주문금액 2배 ${(orderValue * 2).toLocaleString()}원 (spread ${qb.spreadPercent.toFixed(2)}%)`,
            req.ticker);
          return { success: false, message: `호가 깊이 부족 — 주문 취소 (depth ${qb.topBookDepthKrw.toLocaleString()}원)`, quantity, price: orderPrice, fee: 0 };
        }
        // 스프레드가 1.0% 초과면 취소 (체결 시 즉시 손실 과대)
        if (qb.spreadPercent > 1.0) {
          await logSystemEvent('WARN', 'WIDE_SPREAD',
            `매수 주문 취소 — 스프레드 과대`,
            `스프레드 ${qb.spreadPercent.toFixed(2)}% > 1.0% 임계값 (호가 품질 ${qb.quality})`,
            req.ticker);
          return { success: false, message: `스프레드 과대 ${qb.spreadPercent.toFixed(2)}% — 주문 취소`, quantity, price: orderPrice, fee: 0 };
        }
      }
    } catch (err) {
      logger.debug({ err, ticker: req.ticker }, 'Quote book pre-order check skipped');
    }
  }

  // 3. 리스크 체크
  const riskCheck = checkRiskLimits(req.orderType, orderPrice * quantity);
  if (!riskCheck.allowed) {
    return { success: false, message: riskCheck.reason!, quantity, price: orderPrice, fee: 0 };
  }

  // 4. 수수료 계산
  const fee = calculateFee(req.market, orderPrice * quantity);

  // 5. auto_trades에 SUBMITTED 기록
  const { lastId: tradeId } = execute(
    'INSERT INTO auto_trades (stock_id, signal_id, order_type, quantity, price, fee, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.stockId, req.signalId || null, req.orderType, quantity, orderPrice, fee, 'SUBMITTED']
  );

  // 6. KIS 주문 제출
  try {
    let result: { success: boolean; orderNo: string; message: string };

    // 지정가: orderPrice 그대로, 시장가: 0 전달
    const submitPrice = useMarketOrder ? 0 : orderPrice;
    if (req.market === 'KRX') {
      result = await submitDomesticOrder(req.ticker, req.orderType, quantity, submitPrice);
    } else {
      result = await submitOverseasOrder(req.ticker, req.market, req.orderType, quantity, submitPrice);
    }

    if (result.success) {
      // 체결 성공
      execute(
        "UPDATE auto_trades SET status = 'FILLED', kis_order_no = ?, executed_at = datetime('now') WHERE id = ?",
        [result.orderNo, tradeId]
      );

      // 매수 체결 시 거래 내역(transactions)에도 기록
      if (req.orderType === 'BUY') {
        const today = new Date().toISOString().split('T')[0];
        execute(
          'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.stockId, 'BUY', quantity, orderPrice, fee, today, `자동매매 (KIS: ${result.orderNo})`]
        );
      } else {
        const today = new Date().toISOString().split('T')[0];
        execute(
          'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.stockId, 'SELL', quantity, orderPrice, fee, today, `자동매매 (KIS: ${result.orderNo})`]
        );
      }

      logger.info({ orderType: req.orderType, ticker: req.ticker, quantity, price: orderPrice, orderNo: result.orderNo }, 'KIS order filled');

      return {
        success: true,
        orderId: tradeId,
        kisOrderNo: result.orderNo,
        message: result.message,
        quantity,
        price: orderPrice,
        fee,
      };
    } else {
      // 주문 실패
      execute(
        "UPDATE auto_trades SET status = 'FAILED', error_message = ? WHERE id = ?",
        [result.message, tradeId]
      );

      logger.error({ orderType: req.orderType, ticker: req.ticker, message: result.message }, 'KIS order failed');

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
    execute(
      "UPDATE auto_trades SET status = 'FAILED', error_message = ? WHERE id = ?",
      [err.message, tradeId]
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
