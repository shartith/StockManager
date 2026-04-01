/**
 * KIS 주문 API
 * - 국내주식: TTTC0802U (매수), TTTC0801U (매도)
 * - 해외주식: JTTT1002U (매수), JTTT1006U (매도)
 * - 모의투자: VTTC0802U, VTTC0801U (국내) / VTTT1002U, VTTT1001U (해외)
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { queryOne, queryAll, execute } from '../db';

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
): number {
  if (price <= 0) return 0;
  const maxAmount = maxPerStock;
  const quantity = Math.floor(maxAmount / price);
  return Math.max(quantity, market === 'KRX' ? 1 : 1);
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

  const data: any = await response.json();

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

  const data: any = await response.json();

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

/** 주문 실행 (리스크 체크 → 현재가 조회 → 수량 계산 → 주문 제출 → DB 기록) */
export async function executeOrder(req: OrderRequest): Promise<OrderResult> {
  const settings = getSettings();

  // 1. 현재가 조회 (price가 0이면 시장가 주문이지만, 수량 계산을 위해 현재가 필요)
  let orderPrice = req.price;
  if (orderPrice <= 0) {
    const currentPrice = await getCurrentPrice(req.ticker, req.market);
    if (!currentPrice) {
      return { success: false, message: '현재가 조회 실패', quantity: 0, price: 0, fee: 0 };
    }
    orderPrice = currentPrice;
  }

  // 2. 매수 시 수량 계산 (매도 시에는 요청된 수량 사용)
  let quantity = req.quantity;
  if (req.orderType === 'BUY' && quantity <= 0) {
    quantity = calculateOrderQuantity(orderPrice, req.market, settings.autoTradeMaxPerStock);
  }
  if (quantity <= 0) {
    return { success: false, message: '주문 수량 0 — 가격 대비 투자한도 부족', quantity: 0, price: orderPrice, fee: 0 };
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

    if (req.market === 'KRX') {
      result = await submitDomesticOrder(req.ticker, req.orderType, quantity, orderPrice);
    } else {
      result = await submitOverseasOrder(req.ticker, req.market, req.orderType, quantity, orderPrice);
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

      console.log(`[KisOrder] ${req.orderType} 체결: ${req.ticker} ${quantity}주 @ ${orderPrice} (${result.orderNo})`);

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

      console.log(`[KisOrder] ${req.orderType} 실패: ${req.ticker} — ${result.message}`);

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
