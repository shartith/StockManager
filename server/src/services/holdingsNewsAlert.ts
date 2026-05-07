/**
 * 보유 종목 뉴스 알림 (v5.4.0).
 *
 * 1일 1회 (EOD 15:55) 자동 실행 — 당일 보유분 각각에 대해:
 *   1. fetchNaverNews / fetchYahooNews 로 최근 뉴스 fetch
 *   2. summarizeNewsWithAI 로 LLM 한 줄 요약 + 감성 분석
 *   3. system_events 에 INFO 로 push (UI 알림 + 사용자 검토)
 *
 * LLM 모델은 settings.llmModel 사용 (cyankiwi/gemma 권장 — Phase 0 진단 결과).
 */

import { collectAndCacheNews, summarizeNewsWithAI } from './newsCollector';
import { logSystemEvent } from './systemEvent';
import { queryAll } from '../db';
import logger from '../logger';

interface HoldingMini {
  stock_id: number;
  ticker: string;
  name: string;
  market: string;
}

function getCurrentHoldings(): HoldingMini[] {
  return queryAll<HoldingMini>(`
    SELECT s.id as stock_id, s.ticker, s.name, COALESCE(s.market, 'KRX') as market
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `);
}

export async function runHoldingsNewsAlert(): Promise<{
  alerted: number;
  failed: number;
}> {
  const holdings = getCurrentHoldings();
  let alerted = 0;
  let failed = 0;

  for (const h of holdings) {
    try {
      const news = await collectAndCacheNews(h.ticker, h.name, h.market);
      if (!news || news.length === 0) continue;

      const sentiment = await summarizeNewsWithAI(news, h.ticker);
      if (!sentiment.summary) continue;

      const label = sentiment.sentimentLabel === 'POSITIVE' ? '긍정'
        : sentiment.sentimentLabel === 'NEGATIVE' ? '부정'
        : '중립';

      await logSystemEvent('INFO', 'HOLDINGS_NEWS',
        `${h.name} (${h.ticker}) 뉴스 ${label} (${sentiment.sentimentScore})`,
        sentiment.summary,
        h.ticker,
      );
      alerted++;
    } catch (err) {
      failed++;
      logger.warn({ err: (err as Error).message, ticker: h.ticker }, 'holdings news alert failed');
    }
  }

  logger.info({ alerted, failed, total: holdings.length }, '[HoldingsNews] EOD 뉴스 알림 완료');
  return { alerted, failed };
}
