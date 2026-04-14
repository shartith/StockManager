/**
 * 장 마감 30분 전: 수익 종목 이익 실현 매도
 */

import { queryAll } from '../../db';
import { getSettings } from '../settings';
import { executeOrder, getCurrentPrice } from '../kisOrder';
import { createNotification } from '../notification';
import { Market, addLog } from './types';
import { getHoldingInfo, fetchCandleData, analyzeStock, sleep } from './helpers';

/** 장 마감 30분 전: 수익 종목 이익 실현 매도 */
export async function runProfitTaking(market: Market) {
  addLog(market, 'PRE_CLOSE_30M', 'started', '수익 실현 매도 시작');
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    addLog(market, 'PRE_CLOSE_30M', 'completed', '자동매매 비활성화 — 스킵');
    return;
  }

  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');

  const holdingStocks = queryAll(`
    SELECT s.id, s.ticker, s.name, s.market
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.market IN (${ph})
    GROUP BY s.id
    HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, markets);

  let sellCount = 0;
  for (const stock of holdingStocks) {
    try {
      const currentPrice = await getCurrentPrice(stock.ticker, stock.market as any);
      if (!currentPrice) continue;

      const holding = getHoldingInfo(stock.id, currentPrice);
      if (!holding || holding.quantity <= 0) continue;

      const profitRate = holding.unrealizedPnLPercent;

      if (profitRate >= 10) {
        // 10% 이상 수익: 50% 부분 매도
        const sellQty = Math.floor(holding.quantity * 0.5);
        if (sellQty > 0) {
          const result = await executeOrder({
            stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
            orderType: 'SELL', quantity: sellQty, price: 0, signalId: 0,
          });
          if (result.success) {
            sellCount++;
            addLog(market, 'PRE_CLOSE_30M', 'completed',
              `수익실현 50% 매도: ${stock.ticker} ${sellQty}주 (수익률 +${profitRate.toFixed(1)}%)`);
            createNotification({
              type: 'AUTO_TRADE', title: '수익 실현 매도',
              message: `${stock.ticker} ${sellQty}주 부분 매도 (수익률 +${profitRate.toFixed(1)}%, 50% 이익 확보)`,
              ticker: stock.ticker, market, actionUrl: '/transactions',
            });
          }
        }
      } else if (profitRate >= 5 && settings.mlxEnabled) {
        // 5~10% 수익: LLM 판단
        const candles = await fetchCandleData(stock.ticker, market);
        if (!candles || candles.length < 30) continue;

        const decision = await analyzeStock(stock, market, 'PROFIT_TAKING', candles);
        if (decision.signal === 'SELL') {
          const ratio = decision.suggestedRatio || 30;
          const sellQty = Math.floor(holding.quantity * ratio / 100);
          if (sellQty > 0) {
            const result = await executeOrder({
              stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
              orderType: 'SELL', quantity: sellQty, price: 0, signalId: 0,
            });
            if (result.success) {
              sellCount++;
              addLog(market, 'PRE_CLOSE_30M', 'completed',
                `LLM 매도: ${stock.ticker} ${sellQty}주 (수익률 +${profitRate.toFixed(1)}%, ${ratio}%)`);
            }
          }
        }
      }
    } catch (err: any) {
      addLog(market, 'PRE_CLOSE_30M', 'error', `${stock.ticker} 수익실현 오류: ${err.message}`);
    }
  }

  // 일일 리포트
  const todaySignals = queryAll(
    "SELECT signal_type, COUNT(*) as cnt FROM trade_signals WHERE date(created_at) = date('now') AND stock_id IN (SELECT id FROM stocks WHERE market IN (" + ph + ")) GROUP BY signal_type",
    markets
  );
  const todayTrades = queryAll(
    "SELECT order_type, COUNT(*) as cnt FROM auto_trades WHERE date(created_at) = date('now') AND status = 'FILLED' GROUP BY order_type",
    []
  );
  const signalSummary = todaySignals.map((s: any) => `${s.signal_type}: ${s.cnt}건`).join(', ');
  const tradeSummary = todayTrades.map((t: any) => `${t.order_type}: ${t.cnt}건`).join(', ');

  addLog(market, 'PRE_CLOSE_30M', 'completed', `일일 마감 — 신호: ${signalSummary || '없음'} / 체결: ${tradeSummary || '없음'} / 수익실현: ${sellCount}건`);
  createNotification({
    type: 'DAILY_REPORT', title: `${market} 일일 리포트`,
    message: `신호: ${signalSummary || '없음'}\n체결: ${tradeSummary || '없음'}\n수익 실현: ${sellCount}건`,
    market, actionUrl: '/portfolio',
  });
}
