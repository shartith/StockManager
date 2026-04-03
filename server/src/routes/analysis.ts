import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings } from '../services/settings';
import { analyzeTechnical, CandleData } from '../services/technicalAnalysis';
import { checkOllamaStatus, getTradeDecision, buildAnalysisInput, AnalysisPhase } from '../services/ollama';
import { collectAndCacheNews, getCachedNews, summarizeNewsWithAI } from '../services/newsCollector';
import { queryOne, queryAll, execute } from '../db';

const router = Router();

/** 종목 기술적 분석 */
/** 시장 판별 */
function detectMarket(ticker: string): { overseas: boolean; exchCode: string; market: string } {
  const stock: any = queryOne('SELECT market FROM stocks WHERE ticker = ?', [ticker]);
  const market = stock?.market || '';
  const overseasMarkets: Record<string, string> = { NASDAQ: 'NAS', NYSE: 'NYS', NASD: 'NAS', AMEX: 'AMS' };
  if (overseasMarkets[market]) return { overseas: true, exchCode: overseasMarkets[market], market };
  if (/^[A-Z]{1,5}$/.test(ticker)) return { overseas: true, exchCode: 'NAS', market: 'NASDAQ' };
  return { overseas: false, exchCode: '', market: market || 'KRX' };
}

/** 캔들 데이터 조회 (국내/해외 자동 분기) */
async function fetchAnalysisCandles(ticker: string): Promise<CandleData[]> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  const settings = getSettings();
  const token = await getAccessToken();
  const { overseas, exchCode } = detectMarket(ticker);

  const today = new Date();
  const end = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = new Date(today);
  startDate.setFullYear(startDate.getFullYear() - 1);
  const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');

  if (overseas) {
    const trId = settings.kisVirtual ? 'VHHDFS76240000' : 'HHDFS76240000';
    const params = new URLSearchParams({ AUTH: '', EXCD: exchCode, SYMB: ticker, GUBN: '0', BYMD: end, MODP: '1' });
    const response = await fetch(`${baseUrl}/uapi/overseas-price/v1/quotations/dailyprice?${params}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: trId, custtype: 'P' },
    });
    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];
    return (data.output2 || [])
      .filter((item: any) => item.xymd && Number(item.open) > 0)
      .map((item: any) => ({
        time: `${item.xymd.slice(0, 4)}-${item.xymd.slice(4, 6)}-${item.xymd.slice(6, 8)}`,
        open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.clos), volume: Number(item.tvol),
      }))
      .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
  }

  // 국내
  const params = new URLSearchParams({ fid_cond_mrkt_div_code: 'J', fid_input_iscd: ticker, fid_input_date_1: start, fid_input_date_2: end, fid_period_div_code: 'D', fid_org_adj_prc: '0' });
  const response = await fetch(`${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, appkey: appKey, appsecret: appSecret, tr_id: 'FHKST03010100', custtype: 'P' },
  });
  if (!response.ok) return [];
  const data: any = await response.json();
  if (data.rt_cd !== '0') return [];
  return (data.output2 || [])
    .filter((item: any) => item.stck_bsop_date && Number(item.stck_oprc) > 0)
    .map((item: any) => ({
      time: `${item.stck_bsop_date.slice(0, 4)}-${item.stck_bsop_date.slice(4, 6)}-${item.stck_bsop_date.slice(6, 8)}`,
      open: Number(item.stck_oprc), high: Number(item.stck_hgpr), low: Number(item.stck_lwpr), close: Number(item.stck_clpr), volume: Number(item.acml_vol),
    }))
    .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
}

router.get('/:ticker', async (req: Request, res: Response) => {
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
    const stock = queryOne('SELECT name FROM stocks WHERE ticker = ?', [ticker]);
    const { market: detectedMarket } = detectMarket(ticker);

    res.json({
      ticker,
      name: stock?.name || ticker,
      market: detectedMarket,
      indicators,
      dataPoints: candles.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '분석 실패' });
  }
});

/** Ollama 매매 판단 요청 */
router.post('/:ticker/decision', async (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const { phase = 'PRE_OPEN' } = req.body as { phase?: AnalysisPhase };

  try {
    // 종목 정보 조회
    const stock = queryOne('SELECT id, name, market FROM stocks WHERE ticker = ?', [ticker]);
    if (!stock) {
      return res.status(404).json({ error: '등록된 종목이 아닙니다' });
    }

    const market = stock.market || 'KRX';

    // 캔들 데이터 + 기술적 분석
    const { appKey, appSecret, baseUrl } = getKisConfig();
    if (!appKey || !appSecret) {
      return res.status(400).json({ error: 'KIS API 설정이 필요합니다.' });
    }

    const candles = await fetchAnalysisCandles(ticker);
    if (candles.length < 30) {
      return res.status(400).json({ error: '분석에 충분한 데이터가 없습니다 (최소 30일)' });
    }

    const indicators = analyzeTechnical(candles);

    // 보유 현황 조회
    const holdingRow = queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END),0) as buy_qty,
        COALESCE(SUM(CASE WHEN t.type='SELL' THEN t.quantity ELSE 0 END),0) as sell_qty,
        COALESCE(SUM(CASE WHEN t.type='BUY' THEN t.quantity * t.price ELSE 0 END),0) as buy_cost,
        MIN(t.date) as first_date
      FROM transactions t WHERE t.stock_id = ?
    `, [stock.id]);

    let holding: any;
    if (holdingRow && holdingRow.buy_qty > holdingRow.sell_qty) {
      const qty = holdingRow.buy_qty - holdingRow.sell_qty;
      const avgPrice = holdingRow.buy_qty > 0 ? holdingRow.buy_cost / holdingRow.buy_qty : 0;
      const totalCost = avgPrice * qty;
      const currentValue = indicators.currentPrice * qty;
      const holdingDays = holdingRow.first_date
        ? Math.floor((Date.now() - new Date(holdingRow.first_date).getTime()) / 86400000)
        : 0;
      holding = {
        quantity: qty,
        avgPrice: Math.round(avgPrice),
        totalCost: Math.round(totalCost),
        unrealizedPnL: Math.round(currentValue - totalCost),
        unrealizedPnLPercent: totalCost > 0 ? Math.round(((currentValue - totalCost) / totalCost) * 10000) / 100 : 0,
        holdingDays,
      };
    }

    // 뉴스 수집 & 요약 + 감성 분석
    let newsSummary: string | undefined;
    let sentimentScore: number | undefined;
    let sentimentLabel: string | undefined;
    const cachedNews = getCachedNews(ticker);
    if (cachedNews.length > 0) {
      const sentiment = await summarizeNewsWithAI(cachedNews, ticker);
      newsSummary = sentiment.summary;
      sentimentScore = sentiment.sentimentScore;
      sentimentLabel = sentiment.sentimentLabel;
    } else {
      const freshNews = await collectAndCacheNews(ticker, stock.name, market);
      if (freshNews.length > 0) {
        const sentiment = await summarizeNewsWithAI(freshNews, ticker);
        newsSummary = sentiment.summary;
        sentimentScore = sentiment.sentimentScore;
        sentimentLabel = sentiment.sentimentLabel;
      }
    }

    // 구조화된 입력 생성 + Ollama 판단
    const input = buildAnalysisInput(ticker, stock.name, market as any, candles, indicators, holding, newsSummary);
    const decision = await getTradeDecision(input, phase);

    // trade_signals에 저장
    execute(
      'INSERT INTO trade_signals (stock_id, signal_type, source, confidence, indicators_json, llm_reasoning) VALUES (?, ?, ?, ?, ?, ?)',
      [stock.id, decision.signal, `ollama-${phase}`, decision.confidence, JSON.stringify({
        indicators: input.indicators,
        volumeAnalysis: input.volumeAnalysis,
        targetPrice: decision.targetPrice,
        stopLossPrice: decision.stopLossPrice,
        entryPrice: decision.entryPrice,
        keyFactors: decision.keyFactors,
        risks: decision.risks,
      }), decision.reasoning]
    );

    res.json({
      ticker,
      name: stock.name,
      market,
      phase,
      decision,
      indicators: input.indicators,
      volumeAnalysis: input.volumeAnalysis,
      holding: input.holding,
      newsSummary,
      sentimentScore,
      sentimentLabel,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'LLM 판단 실패' });
  }
});

/** Ollama 상태 확인 */
router.get('/ollama/status', async (_req: Request, res: Response) => {
  const status = await checkOllamaStatus();
  res.json(status);
});

/** Ollama 모델 목록 조회 */
router.get('/ollama/models', async (_req: Request, res: Response) => {
  const { getSettings } = await import('../services/settings');
  const settings = getSettings();
  try {
    const r = await fetch(`${settings.ollamaUrl}/api/tags`);
    if (!r.ok) return res.json({ models: [] });
    const data: any = await r.json();
    const models = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
      digest: m.digest?.slice(0, 12),
    }));
    res.json({ models });
  } catch {
    res.json({ models: [] });
  }
});

/** Ollama 모델 다운로드 (스트리밍) */
router.post('/ollama/pull', async (req: Request, res: Response) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: '모델명이 필요합니다' });

  const { getSettings } = await import('../services/settings');
  const settings = getSettings();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const r = await fetch(`${settings.ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });

    if (!r.ok) {
      res.write(`data: ${JSON.stringify({ error: `Ollama 요청 실패: ${r.status}` })}\n\n`);
      res.end();
      return;
    }

    const reader = r.body?.getReader();
    if (!reader) { res.end(); return; }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        } catch { /* skip malformed lines */ }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch { /* */ }
    }

    res.write(`data: ${JSON.stringify({ status: 'success' })}\n\n`);
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

/** Ollama 모델 삭제 */
router.delete('/ollama/models/:name', async (req: Request, res: Response) => {
  const { name } = req.params;
  const { getSettings } = await import('../services/settings');
  const settings = getSettings();
  try {
    const r = await fetch(`${settings.ollamaUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (r.ok) {
      res.json({ success: true });
    } else {
      res.status(r.status).json({ error: `삭제 실패: ${r.status}` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** 뉴스 수집 */
router.get('/:ticker/news', async (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const { refresh } = req.query;

  try {
    if (refresh === 'true') {
      const stock = queryOne('SELECT name, market FROM stocks WHERE ticker = ?', [ticker]);
      const news = await collectAndCacheNews(ticker, stock?.name || ticker, stock?.market || 'KRX');
      return res.json({ news, source: 'fresh' });
    }

    const cached = getCachedNews(ticker);
    if (cached.length > 0) {
      return res.json({ news: cached, source: 'cache' });
    }

    const stock = queryOne('SELECT name, market FROM stocks WHERE ticker = ?', [ticker]);
    const news = await collectAndCacheNews(ticker, stock?.name || ticker, stock?.market || 'KRX');
    res.json({ news, source: 'fresh' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '뉴스 수집 실패' });
  }
});

/** 매매 신호 이력 조회 */
router.get('/:ticker/signals', (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  if (!stock) return res.json([]);

  const signals = queryAll(
    'SELECT * FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 20',
    [stock.id]
  );
  res.json(signals);
});

export default router;
