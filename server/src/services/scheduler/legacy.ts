/**
 * [레거시] runPhase + 4단계 핸들러 — 연속 모니터링으로 대체됨 (호환성 유지)
 */

import { queryAll, queryOne, execute } from '../../db';
import { getSettings } from '../settings';
import { collectAndCacheNews, getCachedNews, summarizeNewsWithAI } from '../newsCollector';
import { executeOrder, getHoldingQuantity } from '../kisOrder';
import { createNotification } from '../notification';
import logger from '../../logger';
import { Market, SchedulePhase, addLog } from './types';
import { fetchCandleData, analyzeStock, sleep } from './helpers';

/** [레거시] 단계별 실행 */
export async function runPhase(market: Market, phase: SchedulePhase) {
  addLog(market, phase, 'started', `${phase} 시작`);

  try {
    const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
    const placeholders = markets.map(() => '?').join(',');

    const watchlistStocks = queryAll(
      `SELECT s.id, s.ticker, s.name, s.market, w.auto_trade_enabled
       FROM watchlist w
       JOIN stocks s ON s.id = w.stock_id
       WHERE w.market IN (${placeholders})`,
      markets
    );

    const holdingStocks = queryAll(
      `SELECT DISTINCT s.id, s.ticker, s.name, s.market
       FROM stocks s
       JOIN transactions t ON t.stock_id = s.id
       WHERE s.market IN (${placeholders})
       GROUP BY s.id
       HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END) > 0`,
      markets
    );

    // 중복 제거
    const stockMap = new Map<number, any>();
    for (const s of [...watchlistStocks, ...holdingStocks]) {
      if (!stockMap.has(s.id)) stockMap.set(s.id, s);
    }
    const stocks = Array.from(stockMap.values());

    if (stocks.length === 0) {
      addLog(market, phase, 'completed', '분석 대상 종목 없음');
      return;
    }

    switch (phase) {
      case 'PRE_OPEN':
        await handlePreOpen(market, stocks);
        break;
      case 'POST_OPEN':
        await handlePostOpen(market, stocks);
        break;
      case 'PRE_CLOSE_1H':
        await handlePreClose1h(market, stocks);
        break;
      case 'PRE_CLOSE_30M':
        await handlePreClose30m(market, stocks);
        break;
    }

    addLog(market, phase, 'completed', `${stocks.length}개 종목 처리 완료`);
  } catch (err: any) {
    addLog(market, phase, 'error', err.message || '알 수 없는 오류');
  }
}

/** 장 시작 전: 뉴스 수집 + AI 요약 + 기술지표 → Ollama 매수 판단 */
export async function handlePreOpen(market: Market, stocks: any[]) {
  const settings = getSettings();

  for (const stock of stocks) {
    try {
      // 1. 뉴스 수집 + AI 요약
      const news = await collectAndCacheNews(stock.ticker, stock.name, market);
      let newsSummary: string | undefined;
      let sentimentScore: number | undefined;
      if (news.length > 0) {
        const sentiment = await summarizeNewsWithAI(news, stock.ticker);
        newsSummary = sentiment.summary;
        sentimentScore = sentiment.sentimentScore;
      }

      // 2. 캔들 + 기술 분석 + LLM 판단
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      if (settings.ollamaEnabled) {
        const decision = await analyzeStock(stock, market, 'PRE_OPEN', candles, newsSummary, sentimentScore);
        addLog(market, 'PRE_OPEN', 'completed',
          `${stock.ticker}: ${decision.signal} (신뢰도 ${decision.confidence}%) — ${decision.reasoning.slice(0, 60)}`);
      }
    } catch (err: any) {
      addLog(market, 'PRE_OPEN', 'error', `${stock.ticker}: ${err.message}`);
    }

    await sleep(100);
  }
}

/** 장 시작 30분 후: 시초가 확인 + 매수 주문 실행 */
export async function handlePostOpen(market: Market, stocks: any[]) {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    addLog(market, 'POST_OPEN', 'completed', '자동매매 비활성화 — 주문 스킵');
    return;
  }

  // 오늘 BUY 신호 조회: 관심종목(auto_trade) + 보유종목 모두 포함
  const markets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const ph = markets.map(() => '?').join(',');
  const buySignals = queryAll(
    `SELECT ts.*, s.ticker, s.name, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     WHERE ts.signal_type = 'BUY'
     AND ts.confidence >= 60
     AND date(ts.created_at) = date('now')
     AND s.market IN (${ph})
     AND (
       EXISTS (SELECT 1 FROM watchlist w WHERE w.stock_id = s.id AND w.auto_trade_enabled = 1)
       OR EXISTS (
         SELECT 1 FROM transactions t WHERE t.stock_id = s.id
         GROUP BY t.stock_id
         HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
       )
     )
     ORDER BY ts.confidence DESC`,
    markets
  );

  for (const signal of buySignals) {
    // 이미 오늘 이 종목에 주문했는지 확인
    const alreadyOrdered = queryOne(
      "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND date(created_at) = date('now') AND status IN ('SUBMITTED', 'FILLED')",
      [signal.stock_id]
    );
    if (alreadyOrdered) continue;

    try {
      const result = await executeOrder({
        stockId: signal.stock_id,
        ticker: signal.ticker,
        market: market as any,
        orderType: 'BUY',
        quantity: 0,
        price: 0,
        signalId: signal.id,
      });

      if (result.success) {
        addLog(market, 'POST_OPEN', 'completed',
          `매수 체결: ${signal.ticker} ${result.quantity}주 @ ${result.price.toLocaleString()} (${result.kisOrderNo})`);

        createNotification({
          type: 'AUTO_TRADE',
          title: `자동매수 체결`,
          message: `${signal.ticker} (${signal.name}) ${result.quantity}주를 ${result.price.toLocaleString()}원에 매수했습니다. (신뢰도 ${signal.confidence}%)`,
          ticker: signal.ticker,
          market,
          actionUrl: '/transactions',
        });
      } else {
        addLog(market, 'POST_OPEN', 'completed', `매수 실패: ${signal.ticker} — ${result.message}`);
      }
    } catch (err: any) {
      addLog(market, 'POST_OPEN', 'error', `매수 오류: ${signal.ticker} — ${err.message}`);
    }
  }
}

/** 장 마감 1시간 전: 보유종목 재평가 + Ollama 매도 판단 */
export async function handlePreClose1h(market: Market, stocks: any[]) {
  const settings = getSettings();

  // 보유 종목만 필터
  const holdingIds = queryAll(
    `SELECT DISTINCT s.id, s.ticker, s.name
     FROM stocks s
     JOIN transactions t ON t.stock_id = s.id
     WHERE s.market = ?
     GROUP BY s.id
     HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type = 'SELL' THEN t.quantity ELSE 0 END) > 0`,
    [market]
  );

  for (const stock of holdingIds) {
    try {
      const candles = await fetchCandleData(stock.ticker, market);
      if (!candles || candles.length < 30) continue;

      let newsSummary: string | undefined;
      const cachedNews = getCachedNews(stock.ticker);
      if (cachedNews.length > 0) {
        const sentiment = await summarizeNewsWithAI(cachedNews, stock.ticker);
        newsSummary = sentiment.summary;
      }

      if (settings.ollamaEnabled) {
        const decision = await analyzeStock(stock, market, 'PRE_CLOSE_1H', candles, newsSummary);
        addLog(market, 'PRE_CLOSE_1H', 'completed',
          `${stock.ticker}: ${decision.signal} (신뢰도 ${decision.confidence}%) — ${decision.reasoning.slice(0, 60)}`);
      }
    } catch (err: any) {
      addLog(market, 'PRE_CLOSE_1H', 'error', `${stock.ticker}: ${err.message}`);
    }

    await sleep(100);
  }
}

/** 장 마감 30분 전: 매도 주문 실행 + 일일 리포트 */
export async function handlePreClose30m(market: Market, stocks: any[]) {
  const settings = getSettings();
  if (!settings.autoTradeEnabled) {
    addLog(market, 'PRE_CLOSE_30M', 'completed', '자동매매 비활성화 — 주문 스킵');
    return;
  }

  // 오늘 SELL 신호 조회: 보유종목 전체 대상
  const sellMarkets = market === 'NYSE' ? ['NYSE', 'NASDAQ', 'NASD', 'AMEX'] : [market];
  const sellPh = sellMarkets.map(() => '?').join(',');
  const sellSignals = queryAll(
    `SELECT ts.*, s.ticker, s.name, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     WHERE ts.signal_type = 'SELL'
     AND ts.confidence >= 60
     AND date(ts.created_at) = date('now')
     AND s.market IN (${sellPh})
     AND EXISTS (
       SELECT 1 FROM transactions t WHERE t.stock_id = s.id
       GROUP BY t.stock_id
       HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
     )
     ORDER BY ts.confidence DESC`,
    sellMarkets
  );

  for (const signal of sellSignals) {
    // 보유 수량 확인
    const holdingQty = getHoldingQuantity(signal.stock_id);
    if (holdingQty <= 0) {
      addLog(market, 'PRE_CLOSE_30M', 'completed', `매도 스킵: ${signal.ticker} — 보유 수량 없음`);
      continue;
    }

    // 이미 오늘 이 종목에 매도 주문했는지 확인
    const alreadyOrdered = queryOne(
      "SELECT id FROM auto_trades WHERE stock_id = ? AND order_type = 'SELL' AND date(created_at) = date('now') AND status IN ('SUBMITTED', 'FILLED')",
      [signal.stock_id]
    );
    if (alreadyOrdered) continue;

    try {
      const result = await executeOrder({
        stockId: signal.stock_id,
        ticker: signal.ticker,
        market: market as any,
        orderType: 'SELL',
        quantity: holdingQty,
        price: 0,
        signalId: signal.id,
      });

      if (result.success) {
        addLog(market, 'PRE_CLOSE_30M', 'completed',
          `매도 체결: ${signal.ticker} ${result.quantity}주 @ ${result.price.toLocaleString()} (${result.kisOrderNo})`);

        createNotification({
          type: 'AUTO_TRADE',
          title: `자동매도 체결`,
          message: `${signal.ticker} (${signal.name}) ${result.quantity}주를 ${result.price.toLocaleString()}원에 매도했습니다. (신뢰도 ${signal.confidence}%)`,
          ticker: signal.ticker,
          market,
          actionUrl: '/transactions',
        });
      } else {
        addLog(market, 'PRE_CLOSE_30M', 'completed', `매도 실패: ${signal.ticker} — ${result.message}`);
      }
    } catch (err: any) {
      addLog(market, 'PRE_CLOSE_30M', 'error', `매도 오류: ${signal.ticker} — ${err.message}`);
    }

    await sleep(500);
  }

  // 일일 리포트
  const todaySignals = queryAll(
    "SELECT signal_type, COUNT(*) as cnt FROM trade_signals WHERE date(created_at) = date('now') GROUP BY signal_type"
  );
  const todayTrades = queryAll(
    "SELECT order_type, status, COUNT(*) as cnt FROM auto_trades WHERE date(created_at) = date('now') GROUP BY order_type, status"
  );
  const signalSummary = todaySignals.map((s: any) => `${s.signal_type}: ${s.cnt}건`).join(', ');
  const tradeSummary = todayTrades.map((t: any) => `${t.order_type}(${t.status}): ${t.cnt}건`).join(', ');
  addLog(market, 'PRE_CLOSE_30M', 'completed', `일일 리포트 — 신호[${signalSummary || '없음'}] 주문[${tradeSummary || '없음'}]`);

  // 일일 리포트 알림
  if (todayTrades.length > 0) {
    createNotification({
      type: 'INFO',
      title: `${market} 일일 거래 리포트`,
      message: `신호: ${signalSummary || '없음'} / 주문: ${tradeSummary || '없음'}`,
      market,
      actionUrl: '/transactions',
    });
  }
}
