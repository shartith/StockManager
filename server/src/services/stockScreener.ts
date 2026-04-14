/**
 * 동적 종목 스크리닝 엔진
 *
 * 매 실행 시 시장 국면(RISING/FLAT/FALLING)을 판별하고,
 * 조건에 맞는 후보 종목을 실시간으로 선정한다.
 *
 * Step 1: 시장 국면 파악 (KOSPI/KOSDAQ 등락률 기반)
 * Step 2: 국면별 조건 필터
 * Step 3: 스코어링 (상위 3개)
 * Step 4: 중복 방지 (직전 실행과 2회 연속 불가)
 */

import { getMarketContext } from './stockPrice';
import { analyzeTechnical, type CandleData } from './technicalAnalysis';
import { getSettings } from './settings';
import { queryAll } from '../db';
import logger from '../logger';

// ── Types ──

export type MarketPhase = 'RISING' | 'FLAT' | 'FALLING';

export interface ScreenedCandidate {
  ticker: string;
  name: string;
  market: string;
  sector: string;
  currentPrice: number;
  changePercent: number;
  volumeRatio: number;        // 오늘 거래량 / 5일 평균
  rsi: number | null;
  bollingerLower: number | null;
  marketCap: number;          // 억원
  score: number;              // 0-100
  scoreBreakdown: {
    volumeScore: number;      // 0-30
    momentumScore: number;    // 0-30
    rsiScore: number;         // 0-20
    capScore: number;         // 0-20
  };
}

export interface ScreeningResult {
  phase: MarketPhase;
  candidates: ScreenedCandidate[];
  skippedReason?: string;
  totalScanned: number;
}

// ── In-memory dedup ──

let lastRunTickers = new Set<string>();

/** 직전 실행에서 선정된 종목 목록 초기화 (테스트용) */
export function resetScreenerDedup(): void {
  lastRunTickers.clear();
}

// ── Step 1: 시장 국면 판별 ──

export function determineMarketPhase(kospiChange: number, kosdaqChange: number): MarketPhase {
  const avg = (kospiChange + kosdaqChange) / 2;
  if (avg >= 0.5) return 'RISING';
  if (avg <= -0.5) return 'FALLING';
  return 'FLAT';
}

// ── Step 2: 후보 종목 가져오기 (DB에 등록된 KRX 종목 + KIS 거래량 순위) ──

interface RawCandidate {
  ticker: string;
  name: string;
  market: string;
  sector: string;
  candles: CandleData[];
}

/**
 * DB에 등록된 KRX 종목의 캔들 데이터를 가져온다.
 * 실제 운영에서는 KIS 거래량 순위 API (FHPST01710000)와 병합하지만,
 * 여기서는 DB 기반으로 한다. 스케줄러에서 KIS 데이터를 주입할 수 있다.
 */
function getDbStocks(market: string): Array<{ ticker: string; name: string; market: string; sector: string }> {
  return queryAll(
    'SELECT ticker, name, market, sector FROM stocks WHERE market = ? AND ticker != ""',
    [market],
  );
}

// ── Step 3: 스코어링 ──

export function scoreCandidate(
  changePercent: number,
  volumeRatio: number,
  rsi: number | null,
  marketCap: number,
): { total: number; volumeScore: number; momentumScore: number; rsiScore: number; capScore: number } {
  // 거래량 증가율: 30점 만점
  const volumeScore = Math.min(30, Math.max(0, (volumeRatio - 1) * 15));

  // 등락률 모멘텀: 30점 만점
  const momentumScore = Math.min(30, Math.max(0, changePercent * 10));

  // RSI 적정 구간 (40-60): 20점 만점
  const rsiScore = rsi !== null
    ? Math.max(0, 20 - Math.abs(rsi - 50))
    : 10; // RSI 없으면 중립 10점

  // 시가총액 (대형주 우선): 20점 만점
  // 500억 = 0점 → 5000억 이상 = 20점
  const capScore = Math.min(20, Math.max(0, (marketCap - 500) / 225));

  return {
    total: Math.round(volumeScore + momentumScore + rsiScore + capScore),
    volumeScore: Math.round(volumeScore * 10) / 10,
    momentumScore: Math.round(momentumScore * 10) / 10,
    rsiScore: Math.round(rsiScore * 10) / 10,
    capScore: Math.round(capScore * 10) / 10,
  };
}

// ── Step 4: 중복 방지 ──

function dedup(
  candidates: ScreenedCandidate[],
  holdingTickers: Set<string>,
): ScreenedCandidate[] {
  return candidates.filter(c => {
    // 보유 종목은 중복 방지 예외
    if (holdingTickers.has(c.ticker)) return true;
    // 직전 실행에서 선정된 종목은 2회 연속 불가
    return !lastRunTickers.has(c.ticker);
  });
}

// ── Main Entry Point ──

/**
 * 동적 스크리닝 실행.
 *
 * @param market 'KRX' 등
 * @param externalCandidates KIS 거래량 순위 등 외부 데이터. 없으면 DB 기반.
 * @param holdingTickers 현재 보유 종목 티커 (중복 방지 예외 처리용)
 * @param candleProvider 캔들 데이터 제공 함수 (DI — 스케줄러에서 주입)
 */
export async function runDynamicScreening(
  market: string,
  holdingTickers?: Set<string>,
  candleProvider?: (ticker: string, market: string) => Promise<CandleData[] | null>,
): Promise<ScreeningResult> {
  const settings = getSettings();

  if (!settings.dynamicScreeningEnabled) {
    return { phase: 'FLAT', candidates: [], skippedReason: '동적 스크리닝 비활성화', totalScanned: 0 };
  }

  // Step 1: 시장 국면 판별
  const ctx = await getMarketContext();
  const kospiChange = ctx.kospi?.changePercent ?? 0;
  const kosdaqChange = ctx.kosdaq?.changePercent ?? 0;
  const phase = determineMarketPhase(kospiChange, kosdaqChange);

  if (phase === 'FALLING') {
    logger.info({ phase, kospi: kospiChange, kosdaq: kosdaqChange }, 'FALLING 국면 — 신규 매수 건너뜀');
    return { phase, candidates: [], skippedReason: 'FALLING 국면 — 현금 보유 유지', totalScanned: 0 };
  }

  // Step 2: 후보 조회
  const dbStocks = getDbStocks(market);
  const volumeRatioMin = settings.screeningVolumeRatioMin ?? 1.5;
  const minMarketCap = settings.screeningMinMarketCap ?? 500;

  const screened: ScreenedCandidate[] = [];
  let totalScanned = 0;

  for (const stock of dbStocks) {
    totalScanned++;
    let candles: CandleData[] | null = null;

    if (candleProvider) {
      candles = await candleProvider(stock.ticker, stock.market);
    }
    if (!candles || candles.length < 20) continue;

    const indicators = analyzeTechnical(candles);
    const currentPrice = indicators.currentPrice;
    if (currentPrice <= 0) continue;

    // 거래량 비율 계산 (최근 거래량 / 5일 평균)
    const volumes = candles.slice(-5).map(c => c.volume);
    const avg5dVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const todayVol = candles[candles.length - 1]?.volume ?? 0;
    const volumeRatio = avg5dVol > 0 ? todayVol / avg5dVol : 0;

    // 등락률
    const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : currentPrice;
    const changePercent = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

    // 시가총액 (추정) — 없으면 0
    const marketCap = 0; // TODO: KIS API에서 가져오거나 fundamentals에서 추출

    // Phase 기반 필터
    if (phase === 'RISING') {
      if (changePercent < 1 || changePercent > 5) continue;
      if (volumeRatio < volumeRatioMin) continue;
      if (changePercent >= 29) continue; // 상한가 제외
    } else if (phase === 'FLAT') {
      const bollingerLower = indicators.bollingerLower;
      if (bollingerLower && currentPrice > bollingerLower * 1.02) continue;
      if (indicators.rsi14 !== null && indicators.rsi14 > 30) continue;
      // 시가총액 필터 (데이터 있을 때만)
      if (marketCap > 0 && marketCap < minMarketCap) continue;
    }

    // Step 3: 스코어링
    const scores = scoreCandidate(changePercent, volumeRatio, indicators.rsi14, marketCap);

    screened.push({
      ticker: stock.ticker,
      name: stock.name,
      market: stock.market,
      sector: stock.sector,
      currentPrice,
      changePercent: Math.round(changePercent * 100) / 100,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      rsi: indicators.rsi14,
      bollingerLower: indicators.bollingerLower,
      marketCap,
      score: scores.total,
      scoreBreakdown: {
        volumeScore: scores.volumeScore,
        momentumScore: scores.momentumScore,
        rsiScore: scores.rsiScore,
        capScore: scores.capScore,
      },
    });
  }

  // 점수 내림차순 정렬 → 상위 3개
  screened.sort((a, b) => b.score - a.score);

  // Step 4: 중복 방지
  const deduplicated = dedup(screened, holdingTickers ?? new Set());
  const top3 = deduplicated.slice(0, 3);

  // 이번 실행 선정 종목 기록 (다음 실행 중복 방지용)
  lastRunTickers = new Set(top3.map(c => c.ticker));

  logger.info(
    { phase, totalScanned, screened: screened.length, selected: top3.length,
      tickers: top3.map(c => c.ticker) },
    '동적 스크리닝 완료',
  );

  return { phase, candidates: top3, totalScanned };
}
