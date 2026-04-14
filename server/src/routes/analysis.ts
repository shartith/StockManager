import { Router, Request, Response } from 'express';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings } from '../services/settings';
import { analyzeTechnical, CandleData } from '../services/technicalAnalysis';
import { checkLlmStatus, getTradeDecision, buildAnalysisInput, AnalysisPhase } from '../services/llm';
import { collectAndCacheNews, getCachedNews, summarizeNewsWithAI } from '../services/newsCollector';
import { queryOne, queryAll, execute } from '../db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { decisionSchema, pullModelSchema } from '../schemas';

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
    res.status(500).json({ error: '분석 실패' });
  }
}));

/** Ollama 매매 판단 요청 */
router.post('/:ticker/decision', validate(decisionSchema), asyncHandler(async (req: Request, res: Response) => {
  const ticker = req.params.ticker as string;
  const { phase } = req.body as { phase: AnalysisPhase };

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
      [stock.id, decision.signal, `mlx-${phase}`, decision.confidence, JSON.stringify({
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
    res.status(500).json({ error: 'LLM 판단 실패' });
  }
}));

/** MLX 서버 상태 확인 — `/v1/models` 기반 */
router.get('/llm/status', asyncHandler(async (_req: Request, res: Response) => {
  const status = await checkLlmStatus();
  res.json(status);
}));

/** MLX에 로드된 모델 조회 — 현재 서버에 로드된 모델(기본 1개) 반환 */
router.get('/llm/models', asyncHandler(async (_req: Request, res: Response) => {
  const settings = getSettings();
  try {
    const r = await fetch(`${settings.mlxUrl}/v1/models`);
    if (!r.ok) return res.json({ models: [] });
    const data: any = await r.json();
    // OpenAI 형식: { data: [{ id, created, owned_by }] }
    const models = (data.data || []).map((m: any) => ({
      name: m.id,
      size: 0, // MLX는 크기 정보 제공 안 함 (파일시스템 스캔 필요)
      modified: m.created ? new Date(m.created * 1000).toISOString() : undefined,
    }));
    res.json({ models });
  } catch {
    res.json({ models: [] });
  }
}));

/**
 * MLX 모델 다운로드 (huggingface-cli download 이용, 스트리밍 출력).
 * mlx_lm.server가 현재 로드 중인 모델은 재시작 없이는 교체 불가.
 * 이 엔드포인트는 캐시만 다운로드하고, 실제 모델 전환은 Settings 저장 후
 * mlx_lm.server 재시작 (stock-manager 재시작) 필요.
 */
router.post('/llm/pull', validate(pullModelSchema), asyncHandler(async (req: Request, res: Response) => {
  const { model } = req.body;
  const venv = process.env.STOCK_MANAGER_VENV
    || `${process.env.HOME}/.stock-manager/venv`;
  const cliPath = `${venv}/bin/huggingface-cli`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { spawn } = await import('child_process');
    const child = spawn(cliPath, ['download', model], {
      env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '0' },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      res.write(`data: ${JSON.stringify({ status: 'downloading', message: text.slice(0, 500) })}\n\n`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      res.write(`data: ${JSON.stringify({ status: 'progress', message: text.slice(0, 500) })}\n\n`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        res.write(`data: ${JSON.stringify({ status: 'success', message: `${model} 다운로드 완료. Settings 저장 후 stock-manager 재시작 필요.` })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: `다운로드 실패 (exit ${code})` })}\n\n`);
      }
      res.end();
    });
    child.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: `huggingface-cli 실행 실패: ${err.message}. venv 설치를 확인하세요.` })}\n\n`);
      res.end();
    });
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: '모델 다운로드 실패' })}\n\n`);
    res.end();
  }
}));

/**
 * MLX 모델 삭제 (HuggingFace 캐시 디렉토리 제거).
 * mlx-community/gemma-3n-E4B-it-4bit → ~/.cache/huggingface/hub/models--mlx-community--gemma-3-4b-it-4bit
 */
router.delete('/llm/models/:name(*)', asyncHandler(async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!name) {
    return res.status(400).json({ error: 'model name required' });
  }
  try {
    const fs = await import('fs');
    const path = await import('path');
    const nameStr = Array.isArray(name) ? name.join('/') : String(name);
    const dirName = `models--${nameStr.replace(/\//g, '--')}`;
    const cacheDir = path.join(process.env.HOME || '', '.cache', 'huggingface', 'hub', dirName);
    if (!fs.existsSync(cacheDir)) {
      return res.status(404).json({ error: '캐시 디렉토리를 찾을 수 없습니다' });
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: `모델 삭제 실패: ${err.message}` });
  }
}));

/** 뉴스 수집 */
router.get('/:ticker/news', asyncHandler(async (req: Request, res: Response) => {
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
    res.status(500).json({ error: '뉴스 수집 실패' });
  }
}));

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
