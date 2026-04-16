/**
 * 추천종목 자동 갱신
 */

import { queryAll, execute } from '../../db';
import { getSettings } from '../settings';
import { analyzeTechnical } from '../technicalAnalysis';
import { getTradeDecision, buildAnalysisInput } from '../llm';
import { collectAndCacheNews, summarizeNewsWithAI } from '../newsCollector';
import { getAccessToken, getKisConfig } from '../kisAuth';
import { evaluateAndScore } from '../scoring';
import logger from '../../logger';
import { Market } from './types';
import { fetchCandleData, sleep } from './helpers';

/** 국내주식 거래량 상위 종목 검색 */
export async function fetchDomesticVolumeRank(appKey: string, appSecret: string, baseUrl: string): Promise<{ticker: string; name: string}[]> {
  try {
    const token = await getAccessToken();
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

    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];

    return (data.output || []).slice(0, 30).map((item: any) => ({
      ticker: item.mksc_shrn_iscd || item.stck_shrn_iscd || '',
      name: item.hts_kor_isnm || '',
    })).filter((c: any) => c.ticker);
  } catch {
    return [];
  }
}

/** 국내주식 등락률 상위 종목 검색 (상승률 기반) */
export async function fetchDomesticFluctuationRank(appKey: string, appSecret: string, baseUrl: string): Promise<{ticker: string; name: string}[]> {
  try {
    const token = await getAccessToken();
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_cond_scr_div_code: '20170',  // 등락률 순위
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

    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];

    return (data.output || []).slice(0, 20).map((item: any) => ({
      ticker: item.mksc_shrn_iscd || item.stck_shrn_iscd || '',
      name: item.hts_kor_isnm || '',
    })).filter((c: any) => c.ticker);
  } catch (err) {
    logger.warn({ err }, '등락률 순위 조회 실패');
    return [];
  }
}

/** 해외주식 거래량 상위 종목 검색 */
async function fetchOverseasVolumeRank(market: Market): Promise<{ticker: string; name: string}[]> {
  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    if (!appKey || !appSecret) return [];

    const token = await getAccessToken();
    const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
    const trId = isVirtual ? 'VHHDFS76410000' : 'HHDFS76410000';

    const params = new URLSearchParams({
      AUTH: '',
      EXCD: exchCode,
      CO_YN_PRICECUR: '',
      CO_ST_PRICECUR: '',
      CO_EN_PRICECUR: '',
      CO_YN_RATE: '',
      CO_ST_RATE: '',
      CO_EN_RATE: '',
      CO_YN_VALX: '',
      CO_ST_VALX: '',
      CO_EN_VALX: '',
      CO_YN_SHAR: '',
      CO_ST_SHAR: '',
      CO_EN_SHAR: '',
      CO_YN_VOLUME: 'Y',
      CO_ST_VOLUME: '100000',
      CO_EN_VOLUME: '',
      CO_YN_AMT: '',
      CO_ST_AMT: '',
      CO_EN_AMT: '',
      CO_YN_EPS: '',
      CO_ST_EPS: '',
      CO_EN_EPS: '',
      CO_YN_PER: '',
      CO_ST_PER: '',
      CO_EN_PER: '',
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

    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];

    return (data.output2 || []).slice(0, 30).map((item: any) => ({
      ticker: item.symb || '',
      name: item.name || item.symb || '',
    })).filter((c: any) => c.ticker);
  } catch {
    return [];
  }
}

/** 해외주식 상승률 기반 종목 검색 */
async function fetchOverseasGainerRank(market: Market): Promise<{ticker: string; name: string}[]> {
  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    if (!appKey || !appSecret) return [];

    const token = await getAccessToken();
    const exchCode = market === 'NYSE' ? 'NYS' : 'NAS';
    const trId = isVirtual ? 'VHHDFS76410000' : 'HHDFS76410000';

    // 등락률 기준으로 검색 (CO_YN_RATE=Y, 상승률 3% 이상)
    const params = new URLSearchParams({
      AUTH: '',
      EXCD: exchCode,
      CO_YN_PRICECUR: '', CO_ST_PRICECUR: '', CO_EN_PRICECUR: '',
      CO_YN_RATE: 'Y', CO_ST_RATE: '3', CO_EN_RATE: '',  // 3% 이상 상승
      CO_YN_VALX: '', CO_ST_VALX: '', CO_EN_VALX: '',
      CO_YN_SHAR: '', CO_ST_SHAR: '', CO_EN_SHAR: '',
      CO_YN_VOLUME: '', CO_ST_VOLUME: '', CO_EN_VOLUME: '',
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

    if (!response.ok) return [];
    const data: any = await response.json();
    if (data.rt_cd !== '0') return [];

    return (data.output2 || []).slice(0, 20).map((item: any) => ({
      ticker: item.symb || '',
      name: item.name || item.symb || '',
    })).filter((c: any) => c.ticker);
  } catch (err) {
    logger.warn({ err }, '해외 상승률 순위 조회 실패');
    return [];
  }
}

/** 추천종목 자동 갱신 (매 1시간, 24시간 운영)
 * v4.14.0: 시장별 TOP 50 경쟁 구도
 * 1) 기존 ACTIVE 추천 재검증 — 감점/가점 적용
 * 2) 포트폴리오 보유 종목 제외
 * 3) 빈 슬롯이 있으면 거래량 상위에서 신규 후보 탐색
 * 4) 50위 밖 종목 퇴출
 */
export async function runRecommendationRefresh() {
  const MAX_PER_MARKET = 50;
  const settings = getSettings();
  if (!settings.llmEnabled) return;

  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret) {
    logger.info('[Scheduler] 추천 갱신 스킵: KIS API 미설정');
    return;
  }

  const markets: Market[] = ['KRX', 'NYSE', 'NASDAQ'];

  for (const market of markets) {
    logger.info(`[Scheduler] 추천종목 갱신 시작: ${market}`);

    // 포트폴리오 보유 종목
    const holdingTickers = new Set(
      queryAll(`
        SELECT DISTINCT s.ticker FROM stocks s
        JOIN transactions t ON t.stock_id = s.id
        WHERE s.market = ?
        GROUP BY s.id
        HAVING SUM(CASE WHEN t.type='BUY' THEN t.quantity ELSE 0 END) - SUM(CASE WHEN t.type='SELL' THEN t.quantity ELSE 0 END) > 0
      `, [market]).map((r: any) => r.ticker)
    );

    // 관심종목 티커 (추천에서 제외 대상)
    const watchlistTickers = new Set(
      queryAll(`
        SELECT s.ticker FROM watchlist w
        JOIN stocks s ON s.id = w.stock_id
        WHERE w.market = ?
      `, [market]).map((r: any) => r.ticker)
    );

    // Step 1: 기존 추천 재검증
    const activeRecs = queryAll(
      "SELECT * FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]
    );

    for (const rec of activeRecs) {
      if (holdingTickers.has(rec.ticker)) {
        execute("UPDATE recommendations SET status = 'DISMISSED' WHERE id = ?", [rec.id]);
        logger.info(`[Scheduler] 추천 제외 (보유 중): ${rec.ticker}`);
        continue;
      }

      // 이미 관심종목에 있으면 추천에서 제외
      if (watchlistTickers.has(rec.ticker)) {
        execute("UPDATE recommendations SET status = 'EXECUTED' WHERE id = ?", [rec.id]);
        logger.info(`[Scheduler] 추천 제외 (관심종목): ${rec.ticker}`);
        continue;
      }

      try {
        const candles = await fetchCandleData(rec.ticker, market);
        if (!candles || candles.length < 30) {
          execute("UPDATE recommendations SET status = 'EXPIRED' WHERE id = ?", [rec.id]);
          continue;
        }

        const indicators = analyzeTechnical(candles);
        const input = buildAnalysisInput(rec.ticker, rec.name, market as any, candles, indicators);
        const decision = await getTradeDecision(input, 'PRE_OPEN');

        // v4.14.0: BUY 아니어도 즉시 제거 안 함 — 스코어링으로 감점 적용
        const reason = `${decision.reasoning} [목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}]`;
        execute("UPDATE recommendations SET confidence = ?, reason = ? WHERE id = ?", [decision.confidence, reason, rec.id]);

        // 스코어링 평가 (BUY/SELL/HOLD 모두 — 감점/가점 반영)
        let quoteBook = undefined;
        try {
          const { getQuoteBook } = await import('../quoteBook');
          quoteBook = (await getQuoteBook(rec.ticker, market as any)) ?? undefined;
        } catch (err) {
          logger.debug({ err, ticker: rec.ticker }, 'Quote book fetch skipped for scoring');
        }
        const scoreResult = await evaluateAndScore(rec.ticker, market, decision, indicators, input.volumeAnalysis, undefined, quoteBook);
        logger.info(`[Scheduler] 점수 갱신: ${rec.ticker} ${decision.signal} ${decision.confidence}% → ${scoreResult.totalScore}점`);
        if (scoreResult.promoted) {
          logger.info(`[Scheduler] 자동 승격: ${rec.ticker} → ${scoreResult.promotedTo} (${scoreResult.totalScore}점)`);
        }
      } catch (err: any) {
        logger.info(`[Scheduler] 추천 검증 오류: ${rec.ticker} — ${err.message}`);
      }
      await sleep(200);
    }

    // Step 2: 빈 슬롯 채우기 — 거래량 + 상승률 상위 검색
    const currentCount = queryAll(
      "SELECT id FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]
    ).length;
    let slotsAvailable = MAX_PER_MARKET - currentCount;

    if (slotsAvailable > 0) {
      const activeTickers = new Set(
        queryAll("SELECT ticker FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market])
          .map((r: any) => r.ticker)
      );

      // 시장별 후보 검색 — 거래량 상위 + 상승률 상위 병합 (중복 제거)
      let volumeCandidates: {ticker: string; name: string}[];
      let gainerCandidates: {ticker: string; name: string}[];

      if (market === 'KRX') {
        [volumeCandidates, gainerCandidates] = await Promise.all([
          fetchDomesticVolumeRank(appKey, appSecret, baseUrl),
          fetchDomesticFluctuationRank(appKey, appSecret, baseUrl),
        ]);
      } else {
        [volumeCandidates, gainerCandidates] = await Promise.all([
          fetchOverseasVolumeRank(market),
          fetchOverseasGainerRank(market),
        ]);
      }

      // 병합 (상승률 우선 — 상승률 후보를 먼저, 이후 거래량 후보 추가)
      const seenTickers = new Set<string>();
      const candidates: {ticker: string; name: string}[] = [];

      for (const c of gainerCandidates) {
        if (c.ticker && !seenTickers.has(c.ticker)) {
          seenTickers.add(c.ticker);
          candidates.push(c);
        }
      }
      for (const c of volumeCandidates) {
        if (c.ticker && !seenTickers.has(c.ticker)) {
          seenTickers.add(c.ticker);
          candidates.push(c);
        }
      }

      logger.info(`[Scheduler] ${market} 후보: 상승률 ${gainerCandidates.length}개 + 거래량 ${volumeCandidates.length}개 = 총 ${candidates.length}개`);

      for (const candidate of candidates) {
        if (slotsAvailable <= 0) break;
        if (!candidate.ticker || holdingTickers.has(candidate.ticker) || activeTickers.has(candidate.ticker) || watchlistTickers.has(candidate.ticker)) continue;

        try {
          const candles = await fetchCandleData(candidate.ticker, market);
          if (!candles || candles.length < 30) continue;

          const indicators = analyzeTechnical(candles);

          let newsSummary: string | undefined;
          const news = await collectAndCacheNews(candidate.ticker, candidate.name, market);
          if (news.length > 0) {
            const sentiment = await summarizeNewsWithAI(news, candidate.ticker);
            newsSummary = sentiment.summary;
          }

          const input = buildAnalysisInput(candidate.ticker, candidate.name, market as any, candles, indicators, undefined, newsSummary);
          const decision = await getTradeDecision(input, 'PRE_OPEN');

          if (decision.signal === 'BUY' && decision.confidence >= 60) {
            const reason = `${decision.reasoning} [목표가: ${decision.targetPrice?.toLocaleString() ?? '-'}, 손절가: ${decision.stopLossPrice?.toLocaleString() ?? '-'}]`;
            const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
            execute(
              'INSERT INTO recommendations (ticker, name, market, source, reason, signal_type, confidence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [candidate.ticker, candidate.name, market, 'llm-auto', reason, 'BUY', decision.confidence, expiresAt]
            );
            activeTickers.add(candidate.ticker);
            slotsAvailable--;
            logger.info(`[Scheduler] 신규 추천: ${candidate.ticker} ${candidate.name} (${decision.confidence}%)`);
          }
        } catch {
          // 개별 종목 오류 무시
        }
        await sleep(200);
      }
    }

    // Step 3: 순위 밖 퇴출 — TOP 50 이후 종목 만료 처리
    const pruned = pruneBottomRanks(market, MAX_PER_MARKET);
    if (pruned > 0) {
      logger.info(`[Scheduler] ${market} 순위 밖 퇴출: ${pruned}개`);
    }

    const finalCount = queryAll("SELECT id FROM recommendations WHERE market = ? AND status = 'ACTIVE'", [market]).length;
    logger.info(`[Scheduler] 추천종목 갱신 완료: ${market} ${finalCount}/${MAX_PER_MARKET}개`);
  }
}

/** 시장별 TOP N 이후 종목을 EXPIRED 처리 */
function pruneBottomRanks(market: string, maxPerMarket: number): number {
  const activeRecs = queryAll(
    "SELECT id, ticker, score FROM recommendations WHERE market = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY score DESC",
    [market]
  );

  let pruned = 0;
  for (let i = maxPerMarket; i < activeRecs.length; i++) {
    const rec = activeRecs[i];
    execute("UPDATE recommendations SET status = 'EXPIRED' WHERE id = ?", [rec.id]);
    logger.info(`[Scheduler] 순위 밖 퇴출: ${rec.ticker} (${i + 1}위, ${rec.score}점)`);
    pruned++;
  }
  return pruned;
}
