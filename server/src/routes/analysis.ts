import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings } from '../services/settings';
import { analyzeTechnical, CandleData } from '../services/technicalAnalysis';
import { checkLlmStatus } from '../services/llm';
import { collectAndCacheNews, getCachedNews } from '../services/newsCollector';
import { queryOne } from '../db';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

/** 종목 기술적 분석 (KRX) */
async function fetchAnalysisCandles(ticker: string): Promise<CandleData[]> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  const token = await getAccessToken();

  const today = new Date();
  const end = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = new Date(today);
  startDate.setFullYear(startDate.getFullYear() - 1);
  const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');

  const params = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J', fid_input_iscd: ticker,
    fid_input_date_1: start, fid_input_date_2: end,
    fid_period_div_code: 'D', fid_org_adj_prc: '0',
  });
  const response = await fetch(
    `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey, appsecret: appSecret,
        tr_id: 'FHKST03010100', custtype: 'P',
      },
    }
  );
  if (!response.ok) return [];
  const data: any = await response.json();
  if (data.rt_cd !== '0') return [];
  return (data.output2 || [])
    .filter((item: any) => item.stck_bsop_date && Number(item.stck_oprc) > 0)
    .map((item: any) => ({
      time: `${item.stck_bsop_date.slice(0, 4)}-${item.stck_bsop_date.slice(4, 6)}-${item.stck_bsop_date.slice(6, 8)}`,
      open: Number(item.stck_oprc), high: Number(item.stck_hgpr),
      low: Number(item.stck_lwpr), close: Number(item.stck_clpr),
      volume: Number(item.acml_vol),
    }))
    .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
}

router.get('/:ticker', asyncHandler(async (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const { appKey, appSecret } = getKisConfig();

  if (!appKey || !appSecret) {
    return res.status(400).json({ error: 'KIS API 설정이 필요합니다.', code: 'NO_CONFIG' });
  }

  try {
    const candles = await fetchAnalysisCandles(ticker);
    if (candles.length < 30) {
      return res.status(400).json({ error: '분석에 충분한 데이터가 없습니다 (최소 30일)' });
    }

    const indicators = analyzeTechnical(candles);
    const stock = queryOne<{ name: string }>('SELECT name FROM stocks WHERE ticker = ?', [ticker]);

    res.json({
      ticker,
      name: stock?.name || ticker,
      market: 'KRX',
      indicators,
      dataPoints: candles.length,
    });
  } catch {
    res.status(500).json({ error: '분석 실패' });
  }
}));

/** 외부 LLM 서버 상태 확인 */
router.get('/llm/status', asyncHandler(async (_req: Request, res: Response) => {
  const status = await checkLlmStatus();
  res.json(status);
}));

/** LLM 서버에 등록된 모델 조회 */
router.get('/llm/models', asyncHandler(async (_req: Request, res: Response) => {
  const settings = getSettings();
  try {
    const headers: Record<string, string> = {};
    if (settings.llmApiKey) headers['Authorization'] = `Bearer ${settings.llmApiKey}`;
    const r = await fetch(`${settings.llmUrl}/models`, { headers });
    if (!r.ok) return res.json({ models: [] });
    const data: any = await r.json();
    const models = (data.data || []).map((m: any) => ({
      name: m.id,
      size: 0,
      modified: m.created ? new Date(m.created * 1000).toISOString() : undefined,
    }));
    res.json({ models });
  } catch {
    res.json({ models: [] });
  }
}));

/** 뉴스 조회 */
router.get('/:ticker/news', asyncHandler(async (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const { refresh } = req.query;

  try {
    if (refresh === 'true') {
      const stock = queryOne<{ name: string; market: string }>(
        'SELECT name, market FROM stocks WHERE ticker = ?', [ticker]
      );
      const news = await collectAndCacheNews(ticker, stock?.name || ticker, stock?.market || 'KRX');
      return res.json({ news, source: 'fresh' });
    }

    const cached = getCachedNews(ticker);
    if (cached.length > 0) {
      return res.json({ news: cached, source: 'cache' });
    }

    const stock = queryOne<{ name: string; market: string }>(
      'SELECT name, market FROM stocks WHERE ticker = ?', [ticker]
    );
    const news = await collectAndCacheNews(ticker, stock?.name || ticker, stock?.market || 'KRX');
    res.json({ news, source: 'fresh' });
  } catch {
    res.status(500).json({ error: '뉴스 수집 실패' });
  }
}));

export default router;
