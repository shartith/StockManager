import { Router, Request, Response } from 'express';
import { getPortfolioSummary } from '../services/calculator';
import { getMultipleStockPrices } from '../services/stockPrice';
import { getKisBalance } from '../services/kisBalance';
import { executeOrder, friendlyOrderError } from '../services/kisOrder';
import { getSettings } from '../services/settings';
import { manualOrderTimeWindow } from '../services/kisMarketHours';
import { isKrxHoliday } from '../services/marketCalendar';
import { getPositionAverages } from '../services/positionAverage';
import { queryAll, queryOne, execute } from '../db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { manualOrderSchema, lockStockSchema } from '../schemas';

const router = Router();

/**
 * 현재 보유 종목(ticker/market) — 반드시 엔진(positionAverage.getPositionAverages,
 * fold+초과매도 클램프)과 동일한 방식으로 판정한다. raw SUM(BUY-SELL)은 원장에
 * 초과매도 기록이 있으면 엔진과 다른 값을 내 시세 조회 대상에서 보유 종목이
 * 누락될 수 있다 (routes/topMarketCap.ts 의 동일 버그 참고).
 */
function getHeldTickers(): { ticker: string; market: string }[] {
  const positions = getPositionAverages();
  const stocks = queryAll<{ id: number; ticker: string; market: string }>(
    `SELECT id, ticker, COALESCE(market, 'KRX') as market FROM stocks WHERE deleted_at IS NULL`,
  );
  return stocks.filter((s) => (positions.get(s.id)?.quantity ?? 0) > 0);
}

router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const heldStocks = getHeldTickers();
    const tickers = heldStocks.map(s => s.ticker);
    const tickerMarkets = new Map<string, string>();
    heldStocks.forEach(s => tickerMarkets.set(s.ticker, s.market || ''));

    let prices: Map<string, number> | undefined;
    if (tickers.length > 0) {
      try {
        prices = await getMultipleStockPrices(tickers, tickerMarkets);
      } catch {}
    }

    const summary = getPortfolioSummary(prices);

    // 정합성: 증권사 실계좌(getKisBalance)가 응답하면 그 실수치를 진실의 원천으로 사용.
    // v6.0.2: 헤드라인(평가금액/매입금액/손익) 덮어씀.
    // v6.0.4: 종목별 breakdown(수량/평단/현재가/손익)도 KIS 로 덮어씀 — 보유/거래 화면의
    //         평균단가가 KIS 매입평균(pchs_avg_pric)과 정확히 일치하도록.
    //         KIS 잔고에 없는 종목(드리프트)만 DB 계산값 유지.
    try {
      const kis = await getKisBalance();
      if (kis && kis.totalEvalAmount > 0) {
        summary.totalCurrentValue = kis.totalEvalAmount;
        summary.totalInvested = kis.totalPurchaseAmount || summary.totalInvested;
        summary.totalProfitLoss = kis.totalProfitLoss;
        summary.totalProfitLossPercent = kis.totalProfitLossRate;

        const kisByTicker = new Map(kis.holdings.map(h => [h.ticker, h]));
        summary.holdings = summary.holdings.map(h => {
          const k = kisByTicker.get(h.ticker);
          if (!k || k.quantity <= 0 || k.avgPrice <= 0) return h; // KIS 에 없으면 DB 폴백
          const totalCost = Math.round(k.avgPrice * k.quantity * 100) / 100;
          const currentValue = k.totalValue > 0 ? k.totalValue : Math.round(k.currentPrice * k.quantity);
          return {
            ...h,
            quantity: k.quantity,
            avgPrice: k.avgPrice,
            totalCost,
            currentPrice: k.currentPrice > 0 ? k.currentPrice : h.currentPrice,
            currentValue,
            profitLoss: Math.round((currentValue - totalCost) * 100) / 100,
            profitLossPercent: k.profitLossRate,
          };
        });

        (summary as typeof summary & { source?: string; stale?: boolean }).source = 'kis';
        (summary as typeof summary & { source?: string; stale?: boolean }).stale = kis.stale ?? false;
      } else {
        (summary as typeof summary & { source?: string }).source = 'db-estimate';
      }
    } catch {
      (summary as typeof summary & { source?: string }).source = 'db-estimate';
    }

    res.json(summary);
  } catch {
    res.status(500).json({ error: '포트폴리오 조회 실패' });
  }
}));

// 수동 주문 — 포트폴리오 화면의 추가매수/매도. 실제 KIS 주문을 실행한다.
// (자동매매 토글과 무관하게 사용자가 직접 낸 주문이므로 executeOrder({ manual: true }))
router.post('/order', validate(manualOrderSchema), asyncHandler(async (req: Request, res: Response) => {
  const { stock_id, type, quantity, price, memo } = req.body as {
    stock_id: number; type: 'BUY' | 'SELL'; quantity: number; price: number; memo: string;
  };

  const settings = getSettings();
  if (!settings.kisAppKey || !settings.kisAppSecret) {
    return res.status(400).json({ error: 'KIS API 설정이 필요합니다. (설정 화면에서 등록하세요)' });
  }
  if (!settings.kisAccountNo) {
    return res.status(400).json({ error: '계좌번호가 설정되지 않았습니다.' });
  }

  // 거래 시간 사전 점검 — 주문외 시간/휴장이면 KIS 호출 없이 즉시 안내 (불필요한 거부 방지).
  // now 를 1회 캡처해 휴장/시간대 판정에 동일 시각을 사용(자정 경계 레이스 제거).
  const now = new Date();
  if (isKrxHoliday(now)) {
    return res.status(400).json({
      error: '오늘은 증시 휴장일(주말·공휴일)입니다. 평일 정규장 09:00~15:30 에 주문하세요.',
      code: 'MARKET_CLOSED',
    });
  }
  const timeWindow = manualOrderTimeWindow(now, !!settings.nxtTradingEnabled);
  if (!timeWindow.open) {
    return res.status(400).json({ error: timeWindow.reason!, code: 'MARKET_CLOSED' });
  }

  const stock = queryOne<{ id: number; ticker: string; name: string }>(
    'SELECT id, ticker, name FROM stocks WHERE id = ? AND deleted_at IS NULL',
    [stock_id],
  );
  if (!stock) {
    return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });
  }

  const result = await executeOrder({
    stockId: stock_id,
    ticker: stock.ticker,
    market: 'KRX',
    orderType: type,
    quantity,
    price: price || 0, // 0 = 현재가 기반 자동(매수 -0.5% 지정가 / 매도 시장가)
    reason: memo ? `수동 주문 — ${memo}` : '수동 주문',
    manual: true,
  });

  if (!result.success) {
    // KIS 거부 사유(시간/가격/잔고/거래정지 등)를 사용자용 안내로 변환해 알림.
    // 원문 메시지는 executeOrder 가 이미 서버 로그에 남기므로 응답 본문엔 노출하지 않는다.
    return res.status(400).json({ error: friendlyOrderError(result.message), code: 'ORDER_FAILED' });
  }
  return res.json({
    success: true,
    message: `${type === 'BUY' ? '매수' : '매도'} 체결 — ${result.quantity}주 @ ${result.price.toLocaleString()}원`,
    quantity: result.quantity,
    price: result.price,
    fee: result.fee,
    kisOrderNo: result.kisOrderNo,
  });
}));

// 종목 거래 고정/해제 — 고정 시 자동매매 매도·재분배 대상에서 제외 (장기 보유 보호).
// 수동 주문(추가매수/매도)에는 영향 없음 — 사용자가 직접 내는 주문은 항상 가능.
router.post('/lock', validate(lockStockSchema), (req: Request, res: Response) => {
  const { stock_id, locked } = req.body as { stock_id: number; locked: boolean };
  const stock = queryOne<{ id: number; name: string }>(
    'SELECT id, name FROM stocks WHERE id = ? AND deleted_at IS NULL',
    [stock_id],
  );
  if (!stock) {
    return res.status(404).json({ error: '종목을 찾을 수 없습니다.' });
  }
  execute('UPDATE stocks SET locked = ? WHERE id = ?', [locked ? 1 : 0, stock_id]);
  return res.json({
    stock_id,
    locked,
    message: locked
      ? `${stock.name} 거래 고정 — 자동매매 매도/재분배에서 제외됩니다.`
      : `${stock.name} 고정 해제됨.`,
  });
});

router.get('/history', (_req: Request, res: Response) => {
  const history = queryAll(`
    SELECT
      t.date,
      SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END) as buy_total,
      SUM(CASE WHEN t.type = 'SELL' THEN t.quantity * t.price ELSE 0 END) as sell_total,
      SUM(t.fee) as fees
    FROM transactions t
    WHERE t.deleted_at IS NULL
    GROUP BY t.date
    ORDER BY t.date ASC
  `);
  res.json(history);
});

export default router;
