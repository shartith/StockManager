/**
 * Paper Trading (가상매매) 엔진
 *
 * 추천 BUY 신호가 발생했지만 실매매가 일어나지 않은 종목을 자동으로
 * 가상 매수하여 학습 데이터로 활용한다. 매도까지의 전 과정을
 * paper_trades 테이블에 기록.
 *
 * 핵심 원칙:
 *   - 실매매 종목과 중복 금지 (실 종목은 가상매매하지 않음)
 *   - 한도/금액 제한 없음 (settings.paperTradeAmount 기본 100만원)
 *   - 매도 규칙은 sellRules.ts 4종 동일 적용 (TARGET_PROFIT/STOP_LOSS/TRAILING/HOLDING_TIME)
 *   - signal_performance에 is_paper=1로 등록 → 정확도 평가 시 실+가상 합산
 */

import { queryAll, queryOne, execute } from '../db';
import { getSettings } from './settings';
import { getMarketContext } from './stockPrice';
import { isOverseasMarket } from './marketNormalizer';
import logger from '../logger';

// ── Types ──

export interface PaperHolding {
  stock_id: number;
  ticker: string;
  name: string;
  market: string;
  quantity: number;
  avgPrice: number;        // BUY price (시뮬에서는 1회 매수만 허용 → 평균단가 = 매수가)
  totalCost: number;       // qty * avgPrice
  buyPaperTradeId: number; // BUY paper_trades.id (pair_id 참조용)
  buyDate: string;         // BUY 시각
  unrealizedPnLPercent: number; // currentPrice 비교 손익률 (계산 후 주입)
}

export interface PaperBuyResult {
  created: boolean;
  reason: string;
  paperTradeId?: number;
  quantity?: number;
}

// ── 헬퍼: 실매매 종목 여부 ──

/**
 * 해당 stock_id가 실매매로 보유 중인지 (transactions 또는 auto_trades 합산).
 * 가상매매는 실 종목과 중복 금지이므로 여기서 true면 paper buy skip.
 */
export function hasRealHolding(stockId: number): boolean {
  const tx = queryOne(
    `SELECT COALESCE(SUM(CASE WHEN type='BUY' THEN quantity ELSE -quantity END), 0) AS qty
     FROM transactions WHERE stock_id = ?`,
    [stockId],
  );
  if ((tx?.qty ?? 0) > 0) return true;

  const at = queryOne(
    `SELECT COALESCE(SUM(CASE WHEN order_type='BUY' THEN quantity ELSE -quantity END), 0) AS qty
     FROM auto_trades WHERE stock_id = ? AND status = 'FILLED'`,
    [stockId],
  );
  return (at?.qty ?? 0) > 0;
}

// ── 헬퍼: 가상 보유 여부 ──

function hasOpenPaperPosition(stockId: number): boolean {
  const row = queryOne(
    `SELECT COALESCE(SUM(CASE WHEN order_type='BUY' THEN quantity ELSE -quantity END), 0) AS qty
     FROM paper_trades WHERE stock_id = ?`,
    [stockId],
  );
  return (row?.qty ?? 0) > 0;
}

// ── 가상 매수 자동 생성 ──

/**
 * 추천 BUY 신호 → 가상매수 자동 트리거.
 *
 * @param currentPrice 신호 발생 시점의 현재가 (KRX는 KRW, 해외는 USD)
 */
export async function autoCreatePaperBuy(args: {
  stockId: number;
  ticker: string;
  market: string;
  signalId?: number;
  recommendationId?: number;
  currentPrice: number;
}): Promise<PaperBuyResult> {
  const { stockId, ticker, market, signalId, recommendationId, currentPrice } = args;
  const settings = getSettings();

  if (!settings.paperTradingEnabled) {
    return { created: false, reason: '가상매매 비활성화' };
  }

  if (currentPrice <= 0) {
    return { created: false, reason: `유효하지 않은 가격: ${currentPrice}` };
  }

  // 1. 실매매 종목과 중복 방지 (가장 중요)
  if (hasRealHolding(stockId)) {
    return { created: false, reason: `실매매 종목 (중복 금지): ${ticker}` };
  }

  // 2. 이미 가상 보유 중인 종목은 BUY 중복 금지
  if (hasOpenPaperPosition(stockId)) {
    return { created: false, reason: `이미 가상 보유 중: ${ticker}` };
  }

  // 3. 수량 계산 — 종목당 paperTradeAmount(KRW) 기준
  const amount = settings.paperTradeAmount ?? 1_000_000;
  let priceKrw = currentPrice;
  if (isOverseasMarket(market)) {
    try {
      const ctx = await getMarketContext();
      priceKrw = currentPrice * (ctx.usdKrw?.price ?? 1400);
    } catch {
      priceKrw = currentPrice * 1400;
    }
  }
  const qty = Math.floor(amount / priceKrw);
  if (qty <= 0) {
    return { created: false, reason: `주가가 paperTradeAmount(${amount.toLocaleString()}원)을 초과` };
  }

  // 4. paper_trades INSERT
  const result = execute(
    `INSERT INTO paper_trades
     (stock_id, signal_id, recommendation_id, order_type, quantity, price, fee, reason)
     VALUES (?, ?, ?, 'BUY', ?, ?, 0, 'auto-from-recommendation')`,
    [stockId, signalId ?? null, recommendationId ?? null, qty, currentPrice],
  );
  const paperTradeId = result.lastId;

  // 5. signal_performance에도 등록 (is_paper=1) — 정확도 평가 시 합산
  if (signalId) {
    try {
      execute(
        `INSERT INTO signal_performance
         (signal_id, stock_id, ticker, market, signal_type, signal_confidence, signal_price, is_paper, paper_trade_id)
         VALUES (?, ?, ?, ?, 'BUY', 0, ?, 1, ?)`,
        [signalId, stockId, ticker, market, currentPrice, paperTradeId],
      );
    } catch (err) {
      logger.debug({ err, signalId }, 'signal_performance paper insert failed (FK 또는 중복)');
    }
  }

  logger.info({ ticker, market, qty, currentPrice, paperTradeId }, '가상매수 생성');
  return { created: true, reason: 'OK', paperTradeId, quantity: qty };
}

// ── 가상 보유 조회 ──

/** 현재 미청산 가상 보유 종목 (BUY - SELL > 0) */
export function getPaperHoldings(): PaperHolding[] {
  const rows = queryAll(`
    SELECT
      pt.stock_id,
      s.ticker, s.name, s.market,
      pt.id AS buyPaperTradeId,
      pt.quantity AS buyQty,
      pt.price AS avgPrice,
      pt.created_at AS buyDate,
      COALESCE((SELECT SUM(quantity) FROM paper_trades WHERE stock_id = pt.stock_id AND order_type='SELL' AND pair_id = pt.id), 0) AS soldQty
    FROM paper_trades pt
    JOIN stocks s ON s.id = pt.stock_id
    WHERE pt.order_type = 'BUY'
    ORDER BY pt.created_at DESC
  `);

  const holdings: PaperHolding[] = [];
  for (const r of rows) {
    const remaining = (r.buyQty as number) - (r.soldQty as number);
    if (remaining <= 0) continue;
    holdings.push({
      stock_id: r.stock_id,
      ticker: r.ticker,
      name: r.name,
      market: r.market,
      quantity: remaining,
      avgPrice: r.avgPrice,
      totalCost: remaining * r.avgPrice,
      buyPaperTradeId: r.buyPaperTradeId,
      buyDate: r.buyDate,
      unrealizedPnLPercent: 0, // 호출처에서 currentPrice로 채움
    });
  }
  return holdings;
}

// ── 가상 매도 ──

export interface PaperSellResult {
  sold: boolean;
  reason: string;
  pnl?: number;
  pnlPercent?: number;
  paperTradeId?: number;
}

/**
 * 가상 매도 실행 — sellRules trigger 또는 수동 호출.
 * BUY paper_trade와 pair_id로 연결되어 P&L 자동 계산.
 */
export function executePaperSell(
  stockId: number,
  currentPrice: number,
  ruleReason: string,
): PaperSellResult {
  // 미청산 BUY 찾기 (가장 오래된 것부터)
  const buy = queryOne(
    `SELECT pt.id, pt.quantity AS buyQty, pt.price AS buyPrice,
      COALESCE((SELECT SUM(quantity) FROM paper_trades WHERE pair_id = pt.id AND order_type='SELL'), 0) AS soldQty
     FROM paper_trades pt
     WHERE pt.stock_id = ? AND pt.order_type = 'BUY'
     ORDER BY pt.created_at ASC
     LIMIT 1`,
    [stockId],
  );

  if (!buy) {
    return { sold: false, reason: 'BUY 기록 없음' };
  }

  const remaining = (buy.buyQty as number) - (buy.soldQty as number);
  if (remaining <= 0) {
    return { sold: false, reason: '이미 전량 매도됨' };
  }

  // P&L 계산 (시뮬레이션 — 수수료 0)
  const buyPrice = buy.buyPrice as number;
  const pnl = (currentPrice - buyPrice) * remaining;
  const pnlPercent = ((currentPrice - buyPrice) / buyPrice) * 100;

  const result = execute(
    `INSERT INTO paper_trades
     (stock_id, order_type, quantity, price, fee, pair_id, reason, pnl, pnl_percent)
     VALUES (?, 'SELL', ?, ?, 0, ?, ?, ?, ?)`,
    [stockId, remaining, currentPrice, buy.id, ruleReason, Math.round(pnl * 100) / 100, Math.round(pnlPercent * 100) / 100],
  );

  logger.info({ stockId, remaining, currentPrice, buyPrice, pnl, pnlPercent, ruleReason }, '가상매도 실행');
  return {
    sold: true,
    reason: ruleReason,
    pnl: Math.round(pnl * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    paperTradeId: result.lastId,
  };
}

// ── 누적 통계 ──

export interface PaperSummary {
  openPositions: number;
  totalRealizedPnL: number;     // 누적 매도 P&L 합계
  totalRealizedPnLPercent: number; // 평균 매도 수익률
  closedTrades: number;          // 매도 완료 거래 수
  winRate: number;               // 매도 거래 중 승률 (pnl > 0 비율)
}

export function getPaperSummary(): PaperSummary {
  const summary = queryOne(`
    SELECT
      COUNT(*) AS closedTrades,
      COALESCE(SUM(pnl), 0) AS totalPnL,
      COALESCE(AVG(pnl_percent), 0) AS avgPnLPercent,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins
    FROM paper_trades WHERE order_type = 'SELL'
  `);

  const openCount = getPaperHoldings().length;
  const closed = summary?.closedTrades ?? 0;
  const wins = summary?.wins ?? 0;

  return {
    openPositions: openCount,
    totalRealizedPnL: Math.round((summary?.totalPnL ?? 0) * 100) / 100,
    totalRealizedPnLPercent: Math.round((summary?.avgPnLPercent ?? 0) * 100) / 100,
    closedTrades: closed,
    winRate: closed > 0 ? Math.round((wins / closed) * 100) : 0,
  };
}
