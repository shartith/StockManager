/**
 * 장 중 10분 간격 연속 모니터링 — 급변 감지 + 즉시 매매
 */

import { queryAll, queryOne, execute } from '../../db';
import { getSettings } from '../settings';
import { executeOrder, getCurrentPrice, calculateOrderQuantity } from '../kisOrder';
import { createNotification } from '../notification';
import { getMultipleStockPrices } from '../stockPrice';
import { manageUnfilledOrders, checkReservedOrders } from '../orderManager';
import logger from '../../logger';
import { Market, addLog, schedulerState } from './types';
import { getHoldingInfo, fetchCandleData, fetchIntradayCandles, analyzeStock, sleep } from './helpers';

/** 위험 감지 즉시 매도 판단 */
function checkEmergencySell(holding: any, currentPrice: number, stockId: number): { sell: boolean; reason: string } {
  const settings = getSettings();
  const stopLoss = -(settings.stopLossPercent || 3);

  // 1. 손절: 매입가 대비 -N% 이상 (기본 -3%)
  if (holding.unrealizedPnLPercent <= stopLoss) {
    return { sell: true, reason: `손절 (${holding.unrealizedPnLPercent.toFixed(1)}%, 기준 ${stopLoss}%)` };
  }

  // 2. 최근 신호의 stopLossPrice 이탈
  const lastSignal = queryOne(
    'SELECT indicators_json FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 1',
    [stockId]
  );
  if (lastSignal?.indicators_json) {
    try {
      const indicators = JSON.parse(lastSignal.indicators_json);
      if (indicators.stopLossPrice && currentPrice <= indicators.stopLossPrice) {
        return { sell: true, reason: `손절가 이탈 (${currentPrice} <= ${indicators.stopLossPrice})` };
      }
    } catch (err) { logger.error({ err, stockId }, 'Failed to parse signal indicators for emergency sell check'); }
  }

  return { sell: false, reason: '' };
}

/** 장 중 10분 간격 연속 모니터링 — 급변 감지 + 즉시 매매 */
export async function runContinuousMonitor(market: Market) {
  const settings = getSettings();
  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');

  // 모니터링 대상: 관심종목 + 보유종목
  const stocks = queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name, s.market FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE s.market IN (${ph})
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, markets);

  if (stocks.length === 0) return;

  // === 분할 매수 2차/3차 체크 ===
  if (settings.autoTradeEnabled) {
    const pendingSplits = queryAll(`
      SELECT at.*, s.ticker, s.name, s.market, at.split_stage, at.price as buy_price
      FROM auto_trades at
      JOIN stocks s ON s.id = at.stock_id
      WHERE at.order_type = 'BUY' AND at.status = 'FILLED'
      AND date(at.created_at) = date('now')
      AND at.split_stage IN (1, 2)
      AND s.market IN (${ph})
    `, markets);

    for (const split of pendingSplits) {
      try {
        const currentPrice = await getCurrentPrice(split.ticker, split.market as any);
        if (!currentPrice) continue;

        // 가격이 매수가 이하면 분할 취소 (추세 이탈)
        if (currentPrice < split.buy_price * 0.98) {
          addLog(market, 'POST_OPEN', 'completed', `분할매수 취소: ${split.ticker} — 가격 하락 (${split.buy_price}→${currentPrice})`);
          continue;
        }

        const nextStage = split.split_stage + 1;
        const ratio = nextStage === 2 ? 0.4 : 0.3;
        const fullQty = calculateOrderQuantity(currentPrice, split.market, settings.autoTradeMaxPerStock);
        const splitQty = Math.max(1, Math.floor(fullQty * ratio));

        const result = await executeOrder({
          stockId: split.stock_id, ticker: split.ticker, market: split.market as any,
          orderType: 'BUY', quantity: splitQty, price: 0, signalId: 0,
        });

        if (result.success) {
          execute(
            "UPDATE auto_trades SET split_stage = ? WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now') AND status = 'FILLED' ORDER BY id DESC LIMIT 1",
            [nextStage, split.stock_id]
          );
          addLog(market, 'POST_OPEN', 'completed',
            `${nextStage}차 분할매수(${Math.round(ratio * 100)}%): ${split.ticker} ${splitQty}주 @ ${currentPrice.toLocaleString()}`);
          createNotification({
            type: 'AUTO_TRADE', title: `${nextStage}차 분할 매수 (${Math.round(ratio * 100)}%)`,
            message: `${split.ticker} ${splitQty}주 추가 매수 — 추세 유지 확인`,
            ticker: split.ticker, market, actionUrl: '/transactions',
          });
        }
      } catch (err) { logger.error({ err, ticker: split.ticker }, 'Split buy failed'); }
    }
  }

  // 시세 일괄 조회
  const tickers = stocks.map((s: any) => s.ticker);
  const tickerMarkets = new Map<string, string>();
  stocks.forEach((s: any) => tickerMarkets.set(s.ticker, s.market));

  let prices: Map<string, number>;
  try {
    prices = await getMultipleStockPrices(tickers, tickerMarkets);
  } catch (err) { logger.error({ err }, 'Failed to fetch multiple stock prices'); return; }

  // WebSocket으로 실시간 시세 브로드캐스트
  if (prices.size > 0) {
    const broadcast = (global as any).__wsBroadcast;
    if (broadcast) {
      const priceData: Record<string, number> = {};
      prices.forEach((price, ticker) => { priceData[ticker] = price; });
      broadcast({ type: 'prices', market, data: priceData, timestamp: new Date().toISOString() });
    }
  }

  let actions = 0;
  for (const stock of stocks) {
    const currentPrice = prices.get(stock.ticker);
    if (!currentPrice) continue;

    const holding = getHoldingInfo(stock.id, currentPrice);

    // === 보유 종목: 위험 감지 → LLM 없이 즉시 매도 ===
    if (holding && holding.quantity > 0 && settings.autoTradeEnabled) {
      const emergency = checkEmergencySell(holding, currentPrice, stock.id);
      if (emergency.sell) {
        try {
          const result = await executeOrder({
            stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
            orderType: 'SELL', quantity: holding.quantity, price: 0, signalId: 0,
          });
          if (result.success) {
            actions++;
            addLog(market, 'POST_OPEN', 'completed', `긴급 매도: ${stock.ticker} ${holding.quantity}주 — ${emergency.reason}`);
            createNotification({
              type: 'AUTO_TRADE', title: '긴급 매도 실행',
              message: `${stock.ticker} (${stock.name}) ${holding.quantity}주 긴급 매도 — ${emergency.reason}`,
              ticker: stock.ticker, market, actionUrl: '/transactions',
            });
          }
        } catch (err) { logger.error({ err, ticker: stock.ticker }, 'Emergency sell failed'); }
        continue;
      }
    }

    // === 가격 변동률 체크 (전회 대비 2% 이상이면 LLM 분석) ===
    const prevPrice = schedulerState.priceCache.get(stock.ticker);
    const changeRate = prevPrice ? Math.abs((currentPrice - prevPrice) / prevPrice * 100) : 999;
    schedulerState.priceCache.set(stock.ticker, currentPrice);

    if (changeRate < 2) continue;

    if (!settings.ollamaEnabled) continue;

    try {
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      // 분봉 단기 추세 조회 (KRX만)
      const intraday = await fetchIntradayCandles(stock.ticker, stock.market || market);

      const decision = await analyzeStock(stock, market, 'INTRADAY', candles, undefined, undefined, undefined, intraday);

      if (settings.autoTradeEnabled) {
        if (decision.signal === 'BUY' && decision.confidence >= 60) {
          const alreadyOrdered = queryOne(
            "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now')",
            [stock.id]
          );
          if (!alreadyOrdered) {
            const result = await executeOrder({
              stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
              orderType: 'BUY', quantity: 0, price: 0, signalId: 0,
            });
            if (result.success) {
              actions++;
              addLog(market, 'POST_OPEN', 'completed',
                `장중 매수: ${stock.ticker} ${result.quantity}주 (변동 ${changeRate.toFixed(1)}%, 신뢰도 ${decision.confidence}%)`);
              createNotification({
                type: 'AUTO_TRADE', title: '장중 매수',
                message: `${stock.ticker} ${result.quantity}주 매수 (가격 ${changeRate.toFixed(1)}% 변동 감지, 신뢰도 ${decision.confidence}%)`,
                ticker: stock.ticker, market, actionUrl: '/transactions',
              });
            }
          }
        } else if (decision.signal === 'SELL' && decision.confidence >= 60 && holding && holding.quantity > 0) {
          const result = await executeOrder({
            stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
            orderType: 'SELL', quantity: holding.quantity, price: 0, signalId: 0,
          });
          if (result.success) {
            actions++;
            addLog(market, 'POST_OPEN', 'completed',
              `장중 매도: ${stock.ticker} ${holding.quantity}주 (변동 ${changeRate.toFixed(1)}%, 신뢰도 ${decision.confidence}%)`);
            createNotification({
              type: 'AUTO_TRADE', title: '장중 매도',
              message: `${stock.ticker} ${holding.quantity}주 매도 (가격 ${changeRate.toFixed(1)}% 변동 감지, 신뢰도 ${decision.confidence}%)`,
              ticker: stock.ticker, market, actionUrl: '/transactions',
            });
          }
        }
      }
    } catch (err: any) {
      addLog(market, 'POST_OPEN', 'error', `${stock.ticker} 장중 분석 오류: ${err.message}`);
    }
    await sleep(100);
  }

  if (actions > 0) {
    logger.info(`[Scheduler] [${market}] 장중 모니터링: ${actions}건 매매 실행`);
  }

  // 미체결 주문 관리 (국내만)
  if (market === 'KRX') {
    try { await manageUnfilledOrders(); } catch (err) { logger.error({ err }, 'manageUnfilledOrders failed'); }
  }

  // 예약 주문 체크
  try { await checkReservedOrders(prices); } catch (err) { logger.error({ err }, 'checkReservedOrders failed'); }
}
