/**
 * DART 공시 실시간 감시
 */

import { queryAll, queryOne, execute } from '../../db';
import { getSettings } from '../settings';
import { getDartDisclosures } from '../dartApi';
import { createNotification } from '../notification';
import logger from '../../logger';
import { sleep } from './helpers';

/** DART 공시 실시간 감시 */
export async function checkDartDisclosures() {
  const settings = getSettings();
  if (!settings.dartEnabled || !settings.dartApiKey) return;

  // 관심종목 + 보유종목의 KRX 종목만
  const stocks = queryAll(`
    SELECT DISTINCT s.id, s.ticker, s.name FROM stocks s
    LEFT JOIN watchlist w ON w.stock_id = s.id
    LEFT JOIN transactions t ON t.stock_id = s.id
    WHERE s.market = 'KRX' AND length(s.ticker) = 6
    GROUP BY s.id
    HAVING COUNT(w.id) > 0 OR SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
  `);

  for (const stock of stocks) {
    try {
      const disclosures = await getDartDisclosures(stock.ticker, 1); // 최근 1일
      for (const d of disclosures) {
        // 이미 저장된 공시인지 확인 (제목+날짜 기준)
        const existing = queryOne(
          'SELECT id FROM dart_disclosures WHERE ticker = ? AND title = ? AND report_date = ?',
          [stock.ticker, d.title, d.reportDate]
        );
        if (existing) continue;

        // 새 공시 저장
        execute(
          'INSERT INTO dart_disclosures (stock_id, ticker, title, report_date, disclosure_type, url, is_important) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [stock.id, stock.ticker, d.title, d.reportDate, d.disclosureType, d.url, d.isImportant ? 1 : 0]
        );

        // 뉴스 캐시에도 추가 (LLM 분석에 반영)
        execute(
          'INSERT INTO news_cache (ticker, title, summary, source_url, sentiment) VALUES (?, ?, ?, ?, ?)',
          [stock.ticker, `[공시] ${d.title}`, d.isImportant ? '주요공시' : '일반공시', d.url, '']
        );

        // 중요 공시면 알림
        if (d.isImportant) {
          createNotification({
            type: 'DART' as any,
            title: `공시 감지: ${stock.ticker}`,
            message: `${stock.name}: ${d.title}`,
            ticker: stock.ticker,
            market: 'KRX',
            actionUrl: d.url,
          });
          logger.info(`[DART] 중요 공시: ${stock.ticker} ${stock.name} — ${d.title}`);
        }
      }
      await sleep(200); // DART API rate limit
    } catch {}
  }
}
