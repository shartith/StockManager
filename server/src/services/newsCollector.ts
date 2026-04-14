/**
 * 뉴스 수집 + Ollama 로컬 AI 요약 서비스
 * 뉴스 수집: 네이버 금융 (국내), Yahoo Finance (해외)
 * 요약: Ollama (로컬 LLM)
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

/** 공시/실적 키워드 특화 뉴스 수집 (국내 종목용) */
async function fetchDisclosureNews(ticker: string, name: string): Promise<NewsItem[]> {
  try {
    const query = encodeURIComponent(`${name} 공시 실적 배당`);
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`);
    if (!res.ok) return [];

    const text = await res.text();
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(text)) !== null && items.length < 3) {
      const itemXml = match[1];
      const title = extractXmlTag(itemXml, 'title');
      const link = extractXmlTag(itemXml, 'link');
      if (title) {
        items.push({
          ticker,
          title: stripHtml(title),
          summary: '[공시/실적]',
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

/** 뉴스 수집 후 DB에 캐시 (공시 뉴스 포함) */
export async function collectAndCacheNews(ticker: string, name: string, market: string): Promise<NewsItem[]> {
  let news: NewsItem[];

  if (market === 'KRX') {
    // 국내: 일반 뉴스 + 공시/실적 뉴스
    const [generalNews, disclosureNews] = await Promise.all([
      fetchNaverNews(ticker, name),
      fetchDisclosureNews(ticker, name),
    ]);
    // 중복 제거 (제목 기준)
    const seen = new Set(generalNews.map(n => n.title));
    news = [...generalNews, ...disclosureNews.filter(n => !seen.has(n.title))];
  } else {
    news = await fetchYahooNews(ticker);
  }

  for (const item of news) {
    execute(
      'INSERT INTO news_cache (ticker, title, summary, source_url, sentiment) VALUES (?, ?, ?, ?, ?)',
      [item.ticker, item.title, item.summary, item.sourceUrl, item.sentiment || '']
    );
  }

  return news;
}

export interface NewsSentiment {
  summary: string;
  sentimentScore: number;  // -100 ~ +100
  sentimentLabel: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}

/** MLX 로컬 LLM으로 뉴스 요약 + 감성 분석 */
export async function summarizeNewsWithAI(newsItems: NewsItem[], ticker: string): Promise<NewsSentiment> {
  const fallback: NewsSentiment = {
    summary: newsItems?.length ? newsItems.map(n => `- ${n.title}`).join('\n') : '',
    sentimentScore: 0,
    sentimentLabel: 'NEUTRAL',
  };

  if (!newsItems || newsItems.length === 0) return fallback;

  const settings = getSettings();
  if (!settings.mlxEnabled || !settings.mlxUrl) return fallback;

  const newsText = newsItems.map((n, i) => `${i + 1}. ${n.title}${n.summary ? '\n   ' + n.summary : ''}`).join('\n');
  const system = '당신은 한국 주식 시장의 뉴스를 분석하는 전문 애널리스트입니다. 반드시 valid JSON으로만 응답하세요.';
  const prompt = `다음은 주식 종목 ${ticker}에 관한 최근 뉴스입니다.

${newsText}

위 뉴스를 분석하여 반드시 아래 JSON 형식으로만 응답하세요:
{
  "summary": "투자 판단에 도움이 되는 3~5문장 요약",
  "sentimentScore": -100에서 +100 사이의 정수 (매우 부정=-100, 중립=0, 매우 긍정=+100),
  "sentimentLabel": "POSITIVE" 또는 "NEGATIVE" 또는 "NEUTRAL"
}`;

  try {
    const { callLlm } = await import('./llm');
    const text = await callLlm(settings.mlxModel, settings.mlxUrl, prompt, system, 500);

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || fallback.summary,
          sentimentScore: Math.max(-100, Math.min(100, Number(parsed.sentimentScore) || 0)),
          sentimentLabel: ['POSITIVE', 'NEGATIVE', 'NEUTRAL'].includes(parsed.sentimentLabel) ? parsed.sentimentLabel : 'NEUTRAL',
        };
      }
    } catch {}

    return { ...fallback, summary: text || fallback.summary };
  } catch {
    return fallback;
  }
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
