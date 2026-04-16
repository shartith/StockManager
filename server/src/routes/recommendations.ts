import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, logAudit } from '../db';
import { analyzeTechnical, CandleData } from '../services/technicalAnalysis';
import { getTradeDecision, buildAnalysisInput, AnalysisPhase } from '../services/llm';
import { collectAndCacheNews, getCachedNews, summarizeNewsWithAI } from '../services/newsCollector';
import { getAccessToken, getKisConfig } from '../services/kisAuth';
import { getSettings } from '../services/settings';
import { normalizeMarket } from '../services/marketNormalizer';
import { expireStaleRecommendations } from '../services/scheduler/watchlistCleanup';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { createRecommendationSchema, updateRecommendationStatusSchema, generateRecommendationSchema } from '../schemas';

const router = Router();

/** 종목명/섹터 기반 카테고리 자동 분류 */
function classifyCategory(name: string, sector: string = ''): string {
  const text = `${name} ${sector}`.toLowerCase();
  const categories: Record<string, string[]> = {
    'AI/반도체': ['ai', '인공지능', '반도체', 'semiconductor', 'gpu', 'nvidia', 'amd', '엔비디아', '삼성전자', 'sk하이닉스', 'chip'],
    '항공우주/방위': ['항공', '우주', '방위', '방산', 'aerospace', 'defense', 'space', '한화에어로', '록히드', 'lockheed', 'boeing'],
    '바이오/헬스': ['바이오', '제약', '헬스', 'bio', 'pharma', 'health', '셀트리온', '삼성바이오', 'pfizer', 'moderna'],
    '2차전지/에너지': ['2차전지', '배터리', '에너지', '태양광', '친환경', 'battery', 'energy', 'solar', 'ev', '전기차', 'lg에너지', 'tesla'],
    '금융': ['금융', '은행', '증권', '보험', 'bank', 'finance', 'insurance', 'financial'],
    '플랫폼/IT': ['플랫폼', '소프트웨어', 'it', '클라우드', 'saas', 'platform', 'software', 'cloud', '카카오', '네이버', 'google', 'meta', 'apple', 'microsoft'],
    '자동차': ['자동차', '모빌리티', 'auto', 'motor', 'car', '현대차', '기아', 'toyota'],
    '소비재/유통': ['소비', '유통', '식품', '음료', 'retail', 'consumer', 'food', '이마트', '쿠팡'],
    '엔터/미디어': ['엔터', '미디어', '게임', '콘텐츠', 'entertainment', 'media', 'game', 'content', '하이브', 'disney', 'netflix'],
    'ETF/지수': ['etf', 'kodex', 'tiger', 'index', '인덱스', '레버리지', '인버스'],
  };

  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(kw => text.includes(kw))) return category;
  }
  return '기타';
}

/** 추천 종목 목록 조회 */
router.get('/', (req: Request, res: Response) => {
  const { market, status, category } = req.query;
  let sql = 'SELECT * FROM recommendations WHERE 1=1';
  const params: any[] = [];

  if (market) { sql += ' AND market = ?'; params.push(market); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  else { sql += " AND status = 'ACTIVE'"; }

  sql += ' ORDER BY created_at DESC LIMIT 50';
  res.json(queryAll(sql, params));
});

/** 카테고리 목록 조회 */
router.get('/categories', (_req: Request, res: Response) => {
  const cats = queryAll(
    "SELECT category, COUNT(*) as count FROM recommendations WHERE status = 'ACTIVE' AND category != '' GROUP BY category ORDER BY count DESC"
  );
  res.json(cats);
});

/** 추천 종목 추가 */
router.post('/', validate(createRecommendationSchema), (req: Request, res: Response) => {
  const { ticker, name, market, source, reason, signal_type, confidence, expires_at } = req.body;

  const { lastId } = execute(
    'INSERT INTO recommendations (ticker, name, market, source, reason, signal_type, confidence, expires_at, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ticker, name, market || 'KRX', source || '', reason || '', signal_type || 'BUY', confidence || 0, expires_at || null, classifyCategory(name)]
  );

  res.json({ id: lastId, message: '추천 종목 추가 완료' });
});

/** 추천 종목 자동 생성 (시장별 최대 50개 — TOP 50 경쟁 구도)
 * 1) 기존 추천 유효성 재검증 — 감점/가점 적용
 * 2) 포트폴리오 보유 종목은 추천에서 제외
 * 3) 추천이 50개 미만이면 시장에서 유망 종목 검색하여 보충
 */
router.post('/generate', asyncHandler(async (req: Request, res: Response) => {
  const MAX_RECOMMENDATIONS = 50;
  const settings = getSettings();
  if (!settings.llmEnabled) {
    return res.status(400).json({ error: 'LLM이 비활성화되어 있습니다. 설정에서 활성화하세요.' });
  }

  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret) {
    return res.status(400).json({ error: 'KIS API 설정이 필요합니다.' });
  }

  const { market = 'KRX' } = req.body as { market?: string };
  const results: any[] = [];

  // ── 포트폴리오 보유 종목 티커 목록 (제외 대상) ──
  const holdingTickers = new Set(
    queryAll(`
      SELECT DISTINCT s.ticker FROM stocks s
      JOIN transactions t ON t.stock_id = s.id
      WHERE s.market = ?
      GROUP BY s.id
      HAVING SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type='SELL' THEN t.quantity ELSE 0 END) > 0
    `, [market]).map((r: any) => r.ticker)
  );

  // ── 관심종목 티커 (제외 대상) ──
  const watchlistTickers = new Set(
    queryAll(`
      SELECT s.ticker FROM watchlist w
      JOIN stocks s ON s.id = w.stock_id
      WHERE w.market = ?
    `, [market]).map((r: any) => r.ticker)
  );

  // ── Step 1: 기존 ACTIVE 추천 재검증 ──
  const activeRecs = queryAll(
    "SELECT * FROM recommendations WHERE market = ? AND status = 'ACTIVE' ORDER BY confidence DESC",
    [market]
  );

  for (const rec of activeRecs) {
    // 포트폴리오에 이미 보유 중이면 제외
    if (holdingTickers.has(rec.ticker)) {
      execute("UPDATE recommendations SET status = 'DISMISSED' WHERE id = ?", [rec.id]);
      results.push({ ticker: rec.ticker, name: rec.name, action: 'dismissed', reason: '포트폴리오 보유 중' });
      continue;
    }
    // 관심종목에 이미 있으면 제외
    if (watchlistTickers.has(rec.ticker)) {
      execute("UPDATE recommendations SET status = 'EXECUTED' WHERE id = ?", [rec.id]);
      results.push({ ticker: rec.ticker, name: rec.name, action: 'executed', reason: '관심종목 등록 중' });
      continue;
    }

    try {
      const candles = await fetchCandlesForRecommendation(rec.ticker, appKey, appSecret, baseUrl, market);
      if (!candles || candles.length < 30) {
        execute("UPDATE recommendations SET status = 'EXPIRED' WHERE id = ?", [rec.id]);
        results.push({ ticker: rec.ticker, name: rec.name, action: 'expired', reason: '데이터 부족' });
        continue;
      }

      const indicators = analyzeTechnical(candles);
      const input = buildAnalysisInput(rec.ticker, rec.name, market as any, candles, indicators);
      const decision = await getTradeDecision(input, 'PRE_OPEN');

      if (decision.signal !== 'BUY' || decision.confidence < 60) {
        execute("UPDATE recommendations SET status = 'EXPIRED' WHERE id = ?", [rec.id]);
        results.push({ ticker: rec.ticker, name: rec.name, action: 'removed', signal: decision.signal, confidence: decision.confidence, reason: 'BUY 신호 아님' });
      } else {
        // 유효 — 신뢰도 업데이트
        const reason = `${decision.reasoning} [목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}]`;
        execute("UPDATE recommendations SET confidence = ?, reason = ? WHERE id = ?", [decision.confidence, reason, rec.id]);
        results.push({ ticker: rec.ticker, name: rec.name, action: 'kept', signal: 'BUY', confidence: decision.confidence });
      }
    } catch (err: any) {
      results.push({ ticker: rec.ticker, name: rec.name, action: 'error', reason: err.message });
    }
  }

  // ── Step 2: 현재 ACTIVE 추천 수 확인 ──
  const currentActive = queryAll(
    "SELECT ticker FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]
  );
  const activeTickers = new Set(currentActive.map((r: any) => r.ticker));
  let slotsAvailable = MAX_RECOMMENDATIONS - currentActive.length;

  if (slotsAvailable <= 0) {
    return res.json({
      message: `${market} 추천 종목 ${currentActive.length}개 유지 (최대 ${MAX_RECOMMENDATIONS}개)`,
      activeCount: currentActive.length,
      results,
    });
  }

  // ── Step 3: 시장에서 유망 종목 검색하여 보충 ──
  const candidateTickers = await searchMarketCandidates(market, appKey, appSecret, baseUrl);

  for (const candidate of candidateTickers) {
    if (slotsAvailable <= 0) break;
    if (holdingTickers.has(candidate.ticker)) continue;  // 포트폴리오 보유 종목 제외
    if (watchlistTickers.has(candidate.ticker)) continue; // 관심종목 제외
    if (activeTickers.has(candidate.ticker)) continue;    // 이미 추천 중인 종목 제외

    try {
      const candles = await fetchCandlesForRecommendation(candidate.ticker, appKey, appSecret, baseUrl, market);
      if (!candles || candles.length < 30) {
        results.push({ ticker: candidate.ticker, name: candidate.name, action: 'skipped', reason: '데이터 부족' });
        continue;
      }

      const indicators = analyzeTechnical(candles);
      const input = buildAnalysisInput(candidate.ticker, candidate.name, market as any, candles, indicators);
      const decision = await getTradeDecision(input, 'PRE_OPEN');

      // trade_signals 저장
      const stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [candidate.ticker]);
      if (stock) {
        execute(
          'INSERT INTO trade_signals (stock_id, signal_type, source, confidence, indicators_json, llm_reasoning) VALUES (?, ?, ?, ?, ?, ?)',
          [stock.id, decision.signal, 'llm-recommend', decision.confidence, JSON.stringify({
            indicators: input.indicators, targetPrice: decision.targetPrice, stopLossPrice: decision.stopLossPrice,
          }), decision.reasoning]
        );
      }

      if (decision.signal === 'BUY' && decision.confidence >= 60) {
        const reason = `${decision.reasoning} [목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}]`;
        const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        execute(
          'INSERT INTO recommendations (ticker, name, market, source, reason, signal_type, confidence, expires_at, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [candidate.ticker, candidate.name, market, 'llm-auto', reason, 'BUY', decision.confidence, expiresAt, classifyCategory(candidate.name)]
        );
        activeTickers.add(candidate.ticker);
        slotsAvailable--;
        results.push({ ticker: candidate.ticker, name: candidate.name, action: 'added', signal: 'BUY', confidence: decision.confidence });
      } else {
        results.push({ ticker: candidate.ticker, name: candidate.name, action: 'rejected', signal: decision.signal, confidence: decision.confidence });
      }
    } catch (err: any) {
      results.push({ ticker: candidate.ticker, name: candidate.name, action: 'error', reason: err.message });
    }
  }

  const finalCount = queryAll("SELECT id FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]).length;
  res.json({
    message: `${market} 추천 종목 ${finalCount}개 (최대 ${MAX_RECOMMENDATIONS}개)`,
    activeCount: finalCount,
    results,
  });
}));

/** 시장에서 유망 종목 후보 검색 (KIS 거래량 상위 + 등록 종목) */
async function searchMarketCandidates(market: string, appKey: string, appSecret: string, baseUrl: string): Promise<{ticker: string; name: string}[]> {
  const candidates: {ticker: string; name: string}[] = [];
  const settings = getSettings();
  const isVirtual = settings.kisVirtual;

  // 1) DB에 등록된 해당 시장 종목
  const dbStocks = queryAll('SELECT ticker, name FROM stocks WHERE market = ?', [market]);
  for (const s of dbStocks) {
    candidates.push({ ticker: s.ticker, name: s.name });
  }

  // 2) KIS API: 거래량 상위 종목 조회
  try {
    const token = await getAccessToken();

    if (market === 'KRX') {
      const params = new URLSearchParams({
        fid_cond_mrkt_div_code: 'J',
        fid_cond_scr_div_code: '20171',
        fid_input_iscd: '0000',
        fid_div_cls_code: '0',
        fid_blng_cls_code: '0',
        fid_trgt_cls_code: '111111111',
        fid_trgt_exls_cls_code: '000000',
        fid_input_price_1: '0',
        fid_input_price_2: '0',
        fid_vol_cnt: '0',
        fid_input_date_1: '',
      });

      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHPST01710000',
            custtype: 'P',
          },
        }
      );

      if (response.ok) {
        const data: any = await response.json();
        if (data.rt_cd === '0' && data.output) {
          for (const item of data.output.slice(0, 20)) {
            const ticker = item.mksc_shrn_iscd || item.stck_shrn_iscd;
            const name = item.hts_kor_isnm || ticker;
            if (ticker && !candidates.find(c => c.ticker === ticker)) {
              candidates.push({ ticker, name: name || ticker });
            }
          }
        }
      }
    } else {
      // 해외주식 (NYSE/NASDAQ) 조건검색
      const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
      const trId = isVirtual ? 'VHHDFS76410000' : 'HHDFS76410000';

      const params = new URLSearchParams({
        AUTH: '',
        EXCD: exchCode,
        CO_YN_PRICECUR: '', CO_ST_PRICECUR: '', CO_EN_PRICECUR: '',
        CO_YN_RATE: '', CO_ST_RATE: '', CO_EN_RATE: '',
        CO_YN_VALX: '', CO_ST_VALX: '', CO_EN_VALX: '',
        CO_YN_SHAR: '', CO_ST_SHAR: '', CO_EN_SHAR: '',
        CO_YN_VOLUME: 'Y', CO_ST_VOLUME: '100000', CO_EN_VOLUME: '',
        CO_YN_AMT: '', CO_ST_AMT: '', CO_EN_AMT: '',
        CO_YN_EPS: '', CO_ST_EPS: '', CO_EN_EPS: '',
        CO_YN_PER: '', CO_ST_PER: '', CO_EN_PER: '',
      });

      const response = await fetch(
        `${baseUrl}/uapi/overseas-price/v1/quotations/inquire-search?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
            custtype: 'P',
          },
        }
      );

      if (response.ok) {
        const data: any = await response.json();
        if (data.rt_cd === '0' && data.output2) {
          for (const item of data.output2.slice(0, 20)) {
            const ticker = item.symb || '';
            const name = item.name || ticker;
            if (ticker && !candidates.find(c => c.ticker === ticker)) {
              candidates.push({ ticker, name });
            }
          }
        }
      }
    }
  } catch {
    // 거래량 상위 조회 실패 시 DB 종목만 사용
  }

  return candidates;
}

/** 추천 종목 상태 변경 */
router.patch('/:id', validate(updateRecommendationStatusSchema), (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;
  const existing = queryOne('SELECT * FROM recommendations WHERE id = ?', [Number(id)]);

  execute('UPDATE recommendations SET status = ? WHERE id = ?', [status, Number(id)]);
  logAudit('recommendations', Number(id), 'UPDATE', existing, { status });
  res.json({ message: '상태 업데이트 완료' });
});

/** 추천 종목 삭제 */
router.delete('/:id', (req: Request, res: Response) => {
  execute('DELETE FROM recommendations WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: '삭제 완료' });
});

/** 추천 종목 → 관심종목에 추가 */
router.post('/:id/watch', (req: Request, res: Response) => {
  const rec = queryOne('SELECT * FROM recommendations WHERE id = ?', [Number(req.params.id)]);
  if (!rec) return res.status(404).json({ error: '추천 종목을 찾을 수 없습니다' });

  // 종목이 없으면 생성 (market 코드 정규화)
  let stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [rec.ticker]);
  if (!stock) {
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', [rec.ticker, rec.name, normalizeMarket(rec.market)]);
    stock = queryOne('SELECT id FROM stocks WHERE ticker = ?', [rec.ticker]);
  }

  // 관심종목에 추가 (중복 무시)
  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ?', [stock.id]);
  if (!existing) {
    execute('INSERT INTO watchlist (stock_id, market, notes) VALUES (?, ?, ?)',
      [stock.id, rec.market, `추천: ${rec.reason}`]);
  }

  // 추천 상태를 EXECUTED로 변경
  execute("UPDATE recommendations SET status = 'EXECUTED' WHERE id = ?", [rec.id]);

  res.json({ message: '관심종목에 추가되었습니다', stockId: stock.id });
});

/** 캔들 데이터 조회 헬퍼 (국내/해외 분기) */
async function fetchCandlesForRecommendation(ticker: string, appKey: string, appSecret: string, baseUrl: string, market: string = 'KRX'): Promise<CandleData[] | null> {
  try {
    const token = await getAccessToken();
    const settings = getSettings();
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(today);
    startDate.setMonth(startDate.getMonth() - 6);
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, '');

    if (market !== 'KRX') {
      // 해외주식 일봉
      const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
      const trId = settings.kisVirtual ? 'VHHDFS76240000' : 'HHDFS76240000';

      const params = new URLSearchParams({
        AUTH: '', EXCD: exchCode, SYMB: ticker,
        GUBN: '0', BYMD: end, MODP: '1',
      });

      const response = await fetch(
        `${baseUrl}/uapi/overseas-price/v1/quotations/dailyprice?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: trId, custtype: 'P',
          },
        }
      );

      if (!response.ok) return null;
      const data: any = await response.json();
      if (data.rt_cd !== '0') return null;

      return (data.output2 || [])
        .filter((item: any) => item.xymd && Number(item.open) > 0)
        .map((item: any) => ({
          time: `${item.xymd.slice(0, 4)}-${item.xymd.slice(4, 6)}-${item.xymd.slice(6, 8)}`,
          open: Number(item.open), high: Number(item.high),
          low: Number(item.low), close: Number(item.clos),
          volume: Number(item.tvol),
        }))
        .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
    }

    // 국내주식 일봉
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
      fid_input_date_1: start,
      fid_input_date_2: end,
      fid_period_div_code: 'D',
      fid_org_adj_prc: '0',
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

    if (!response.ok) return null;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return null;

    return (data.output2 || [])
      .filter((item: any) => item.stck_bsop_date && Number(item.stck_oprc) > 0)
      .map((item: any) => ({
        time: `${item.stck_bsop_date.slice(0, 4)}-${item.stck_bsop_date.slice(4, 6)}-${item.stck_bsop_date.slice(6, 8)}`,
        open: Number(item.stck_oprc), high: Number(item.stck_hgpr),
        low: Number(item.stck_lwpr), close: Number(item.stck_clpr),
        volume: Number(item.acml_vol),
      }))
      .sort((a: CandleData, b: CandleData) => (a.time > b.time ? 1 : -1));
  } catch {
    return null;
  }
}

/** 낮은 평가/만료 추천종목 일괄 정리 (수동 트리거, LLM 무관) */
router.post('/cleanup', (_req: Request, res: Response) => {
  const result = expireStaleRecommendations();
  res.json({
    success: true,
    message: `${result.expired}건 만료, ${result.purged}건 영구 삭제 (30일 이상)`,
    ...result,
  });
});

export default router;
