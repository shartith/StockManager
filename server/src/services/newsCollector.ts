/**
 * 외부 데이터 수집 + AI 요약 서비스
 * 뉴스 수집: 네이버 금융 (국내), Yahoo Finance (해외)
 * 요약: Claude API 또는 OpenAI API
 */

import { getSettings } from './settings';
import { execute, queryAll } from '../db';

export interface NewsItem {
  ticker: string;
  title: string;
  summary: string;
  sourceUrl: string;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | '';
}

/** 네이버 금융 뉴스 수집 (국내 종목) */
export async function fetchNaverNews(ticker: string, name: string): Promise<NewsItem[]> {
  try {
    // 네이버 검색 API (뉴스)
    const query = encodeURIComponent(`${name} 주식`);
    const res = await fetch(
      `https://openapi.naver.com/v1/search/news.json?query=${query}&display=5&sort=date`,
      {
        headers: {
          'X-Naver-Client-Id': 'news_collector',
          'X-Naver-Client-Secret': '',
        },
      }
    );

    if (!res.ok) {
      // 네이버 API 키 없이 RSS fallback
      return await fetchNaverRSS(ticker, name);
    }

    const data: any = await res.json();
    return (data.items || []).map((item: any) => ({
      ticker,
      title: stripHtml(item.title),
      summary: stripHtml(item.description),
      sourceUrl: item.link,
      sentiment: '' as const,
    }));
  } catch {
    return fetchNaverRSS(ticker, name);
  }
}

/** 네이버 금융 RSS fallback */
async function fetchNaverRSS(ticker: string, name: string): Promise<NewsItem[]> {
  try {
    const query = encodeURIComponent(`${name} 주식`);
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`);
    if (!res.ok) return [];

    const text = await res.text();
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(text)) !== null && items.length < 5) {
      const itemXml = match[1];
      const title = extractXmlTag(itemXml, 'title');
      const link = extractXmlTag(itemXml, 'link');
      if (title) {
        items.push({
          ticker,
          title: stripHtml(title),
          summary: '',
          sourceUrl: link || '',
          sentiment: '',
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** Yahoo Finance 뉴스 수집 (해외 종목) */
export async function fetchYahooNews(ticker: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`
    );
    if (!res.ok) return [];

    const text = await res.text();
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(text)) !== null && items.length < 5) {
      const itemXml = match[1];
      const title = extractXmlTag(itemXml, 'title');
      const description = extractXmlTag(itemXml, 'description');
      const link = extractXmlTag(itemXml, 'link');
      if (title) {
        items.push({
          ticker,
          title: stripHtml(title),
          summary: stripHtml(description || ''),
          sourceUrl: link || '',
          sentiment: '',
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** 뉴스 수집 후 DB에 캐시 */
export async function collectAndCacheNews(ticker: string, name: string, market: string): Promise<NewsItem[]> {
  const news = market === 'KRX'
    ? await fetchNaverNews(ticker, name)
    : await fetchYahooNews(ticker);

  for (const item of news) {
    execute(
      'INSERT INTO news_cache (ticker, title, summary, source_url, sentiment) VALUES (?, ?, ?, ?, ?)',
      [item.ticker, item.title, item.summary, item.sourceUrl, item.sentiment || '']
    );
  }

  return news;
}

/** 외부 AI로 뉴스 요약 (Claude / OpenAI) */
export async function summarizeNewsWithAI(newsItems: NewsItem[], ticker: string): Promise<string> {
  const settings = getSettings();

  if (settings.externalAiProvider === 'none' || !settings.externalAiApiKey) {
    // AI 미설정: 제목만 나열
    return newsItems.map(n => `- ${n.title}`).join('\n');
  }

  const newsText = newsItems.map((n, i) => `${i + 1}. ${n.title}\n   ${n.summary}`).join('\n');
  const prompt = `다음은 주식 종목 ${ticker}에 관한 최근 뉴스입니다. 투자 판단에 도움이 되도록 핵심 내용을 3~5문장으로 요약하고, 전반적인 시장 심리(긍정/부정/중립)를 판단해주세요.\n\n${newsText}`;

  if (settings.externalAiProvider === 'claude') {
    return await callClaudeAPI(prompt, settings.externalAiApiKey, settings.externalAiModel);
  } else if (settings.externalAiProvider === 'openai') {
    return await callOpenAIAPI(prompt, settings.externalAiApiKey, settings.externalAiModel);
  }

  return newsItems.map(n => `- ${n.title}`).join('\n');
}

async function callClaudeAPI(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API 오류: ${res.status}`);
  const data: any = await res.json();
  return data.content?.[0]?.text || '요약 실패';
}

async function callOpenAIAPI(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI API 오류: ${res.status}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content || '요약 실패';
}

/** 캐시된 뉴스 조회 (최근 24시간) */
export function getCachedNews(ticker: string): NewsItem[] {
  return queryAll(
    "SELECT ticker, title, summary, source_url as sourceUrl, sentiment FROM news_cache WHERE ticker = ? AND fetched_at > datetime('now', '-1 day') ORDER BY fetched_at DESC LIMIT 10",
    [ticker]
  );
}

// 유틸리티
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

function extractXmlTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : null;
}
