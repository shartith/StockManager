/**
 * 장 시작 전: 뉴스 수집 + 초기 분석 + 즉시 매수
 */

import { queryAll, queryOne, execute } from '../../db';
import { getSettings } from '../settings';
import { collectAndCacheNews, summarizeNewsWithAI } from '../newsCollector';
import { getCurrentPrice, calculateOrderQuantity } from '../kisOrder';
import { executeOrder } from '../kisOrder';
import { createNotification } from '../notification';
import { getMarketContext, formatMarketContext } from '../stockPrice';
import logger from '../../logger';
import { Market, addLog } from './types';
import { fetchCandleData, analyzeStock, sleep } from './helpers';
import { runDynamicScreening } from '../stockScreener';
import { autoCreatePaperBuy } from '../paperTrading';

/** 장 시작 전: 뉴스 수집 + 초기 분석 + 즉시 매수 */
export async function runMarketOpen(market: Market) {
  addLog(market, 'PRE_OPEN', 'started', '장 시작 10분 관망 후 분석 시작');
  const settings = getSettings();

  // 동적 스크리닝: FALLING 국면이면 신규 매수 건너뜀
  if (settings.dynamicScreeningEnabled && settings.autoTradeEnabled) {
    try {
      const screening = await runDynamicScreening(market, undefined, (t, _m) => fetchCandleData(t, market));
      if (screening.phase === 'FALLING') {
        addLog(market, 'PRE_OPEN', 'completed',
          `${screening.skippedReason} — 보유 종목 모니터링만 계속 (continuousMonitor에서 매도 규칙 적용)`);
        return;
      }
      if (screening.candidates.length > 0) {
        addLog(market, 'PRE_OPEN', 'completed',
          `${screening.phase} 국면 — 스크리닝 후보: ${screening.candidates.map(c => `${c.ticker}(${c.score}점)`).join(', ')}`);
      }
    } catch (err) {
      logger.error({ err, market }, '동적 스크리닝 실패 — 기본 분석으로 진행');
    }
  }

  // 글로벌 시장 컨텍스트 조회
  let marketContextStr: string | undefined;
  try {
    const ctx = await getMarketContext();
    marketContextStr = formatMarketContext(ctx, market);
    if (marketContextStr) logger.info(`[Scheduler] [${market}] 시장 동향:\n  ${marketContextStr}`);
  } catch (err) { logger.error({ err, market }, 'Failed to get market context'); }

  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');

  const stocks = queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name, s.market FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE (w.market IN (${ph}) OR s.market IN (${ph}))
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `, [...markets, ...markets]);

  if (stocks.length === 0) {
    addLog(market, 'PRE_OPEN', 'completed', '분석 대상 종목 없음');
    return;
  }

  let buyCount = 0;
  for (const stock of stocks) {
    try {
      const news = await collectAndCacheNews(stock.ticker, stock.name, stock.market || market);
      let newsSummary: string | undefined;
      let sentimentScore: number | undefined;
      if (news.length > 0) {
        const sentiment = await summarizeNewsWithAI(news, stock.ticker);
        newsSummary = sentiment.summary;
        sentimentScore = sentiment.sentimentScore;
      }

      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      if (settings.mlxEnabled) {
        const decision = await analyzeStock(stock, market, 'MARKET_OPEN', candles, newsSummary, sentimentScore, marketContextStr);

        // 1차 분할 매수 (30%) — 시초가 관망 후 즉시
        if (decision.signal === 'BUY' && decision.confidence >= 60 && settings.autoTradeEnabled) {
          const alreadyOrdered = queryOne(
            "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now')",
            [stock.id]
          );
          let realBought = false;
          if (!alreadyOrdered) {
            try {
              // 30% 수량만 매수 (1차 분할)
              const price = await getCurrentPrice(stock.ticker, stock.market as any);
              if (price && price > 0) {
                const fullQty = calculateOrderQuantity(price, stock.market, settings.autoTradeMaxPerStock);
                const splitQty = Math.max(1, Math.floor(fullQty * 0.3));
                const result = await executeOrder({
                  stockId: stock.id, ticker: stock.ticker, market: stock.market as any,
                  orderType: 'BUY', quantity: splitQty, price: 0, signalId: 0,
                });
                if (result.success) {
                  // split_stage=1 기록
                  execute("UPDATE auto_trades SET split_stage = 1 WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now') AND status = 'FILLED'", [stock.id]);
                  buyCount++;
                  realBought = true;
                  addLog(market, 'PRE_OPEN', 'completed',
                    `1차 분할매수(30%): ${stock.ticker} ${splitQty}주 @ ${result.price?.toLocaleString()} (신뢰도 ${decision.confidence}%)`);
                  createNotification({
                    type: 'AUTO_TRADE', title: '1차 분할 매수 (30%)',
                    message: `${stock.ticker} (${stock.name}) ${splitQty}주 매수 — 2차(40%) 10분 후 추세 확인`,
                    ticker: stock.ticker, market, actionUrl: '/transactions',
                  });
                } else {
                  addLog(market, 'PRE_OPEN', 'error',
                    `1차 분할매수 실패: ${stock.ticker} — ${result.message || '실행 오류'}`);
                }
              }
            } catch (err) { logger.error({ err, ticker: stock.ticker }, 'Split buy order execution failed'); }
          }

          // 실매수 안 되었으면 가상매수 (학습 데이터화)
          if (!realBought && settings.paperTradingEnabled) {
            try {
              const price = await getCurrentPrice(stock.ticker, stock.market as any);
              if (price && price > 0) {
                const paperResult = await autoCreatePaperBuy({
                  stockId: stock.id, ticker: stock.ticker, market: stock.market || market,
                  currentPrice: price,
                });
                if (paperResult.created) {
                  addLog(market, 'PRE_OPEN', 'completed',
                    `가상매수: ${stock.ticker} ${paperResult.quantity}주 @ ${price.toLocaleString()} (실매수 불가 → 학습 데이터)`);
                  createNotification({
                    type: 'AUTO_TRADE', title: '가상매수 (PRE_OPEN)',
                    message: `${stock.ticker} ${paperResult.quantity}주 가상매수 — 학습 데이터`,
                    ticker: stock.ticker, market, actionUrl: '/transactions',
                  });
                }
              }
            } catch (err) { logger.error({ err, ticker: stock.ticker }, 'Paper buy failed'); }
          }
        }
      }
      await sleep(100);
    } catch (err: any) {
      addLog(market, 'PRE_OPEN', 'error', `${stock.ticker} 분석 오류: ${err.message}`);
    }
  }
  addLog(market, 'PRE_OPEN', 'completed', `장 시작 분석 완료: ${stocks.length}종목 분석, ${buyCount}건 매수`);
}
