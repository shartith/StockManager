/**
 * v6.1.4 — B2(미보유 Top10 매수) 급등 우선매수 버킷 + 연속상승 확인 + 스왑매도 검증.
 *
 * 배경: 시총순위 그대로 사면 비싼 상위권 종목에 현금이 먼저 소진돼, 정작 지금
 * 급등 중인 8~10위 종목을 놓칠 수 있다는 사용자 리포트. evaluateBuyCandidates 가
 * 등락률 임계치 이상+연속상승 확인된 미보유 Top10 종목을 큐 앞으로 당기는지 검증.
 *
 * 이어서 사용자가 "이미 많이 올랐으면 오히려 하락하지 않겠나"를 지적해 상한(MAX)
 * 캡을 추가했고, "급등은 9시 개장 직후부터 시작된다"는 관찰 + 1분봉 실측 분석
 * (scripts/analyze-minute-patterns.mjs) 결과를 반영해 단발 틱이 아니라 연속
 * 상승 확인(isSteadyRiser)을 요구하도록 바뀌었다. 마지막으로 "손실액이 적은
 * 종목을 팔아 급등주를 사되 시총을 비교해 판단" 요청으로 스왑매도(findSwapSellTarget)
 * 를 추가했다 — 이 파일에서 전부 검증한다.
 */

import { describe, it, expect } from 'vitest';
import { evaluateBuyCandidates, isSteadyRiser, findSwapSellTarget } from '../services/rebalanceStrategy';
import type { TopMarketCapResult, TopStock } from '../services/topMarketCap';

function stock(overrides: Partial<TopStock>): TopStock {
  return {
    rank: 1,
    ticker: '000000',
    name: '테스트',
    market: 'KOSPI',
    marketCapKrw: 0,
    marketCapEok: 0,
    marketCapHangeul: '',
    closePrice: 10000,
    fluctuationsRatio: 0,
    ...overrides,
  };
}

function topResult(top10: TopStock[]): TopMarketCapResult {
  return { top10, top20: top10, topExtended: top10, fetchedAt: new Date(0).toISOString(), source: 'naver-mobile' };
}

/** isSteadyRiser 를 통과하는 5샘플 버퍼(오래된 것부터) — 총 +2.0% 연속 상승. */
function confirmedBuffer(currentPct: number): number[] {
  return [currentPct - 2, currentPct - 1.5, currentPct - 1, currentPct - 0.5, currentPct];
}

const NO_BUFFERS = new Map<string, number[]>();

describe('evaluateBuyCandidates — 급등 우선매수 버킷 (연속상승 확인 포함)', () => {
  it('등락률 임계치 이상 + 연속상승 확인된 낮은순위 종목이 시총 1위보다 먼저 온다', () => {
    const rank1Flat = stock({ rank: 1, ticker: 'RANK1', fluctuationsRatio: 0.5 });
    const rank8Spike = stock({ rank: 8, ticker: 'RANK8', fluctuationsRatio: 4.67 });
    const rank10Normal = stock({ rank: 10, ticker: 'RANK10', fluctuationsRatio: 1.2 });
    const buffers = new Map([['RANK8', confirmedBuffer(4.67)]]);

    const candidates = evaluateBuyCandidates(
      topResult([rank1Flat, rank8Spike, rank10Normal]),
      [],
      'marketcap',
      buffers,
    );

    expect(candidates.map((c) => c.stock.ticker)).toEqual(['RANK8', 'RANK1', 'RANK10']);
    expect(candidates[0].reason).toContain('급등 우선매수');
    expect(candidates[0].spiking).toBe(true);
    expect(candidates[1].reason).toContain('신규 진입');
    expect(candidates[1].spiking).toBe(false);
  });

  it('등락률은 임계치 이상이어도 연속상승 확인이 안 되면(버퍼 없음) 일반 순서 그대로', () => {
    const rank1 = stock({ rank: 1, ticker: 'RANK1', fluctuationsRatio: 0.5 });
    const rank8 = stock({ rank: 8, ticker: 'RANK8', fluctuationsRatio: 4.67 }); // 버퍼 없음 — 미확인

    const candidates = evaluateBuyCandidates(topResult([rank1, rank8]), [], 'marketcap', NO_BUFFERS);

    expect(candidates.map((c) => c.stock.ticker)).toEqual(['RANK1', 'RANK8']);
    expect(candidates.every((c) => !c.spiking)).toBe(true);
  });

  it('임계치 미만 종목들은 기존 시총순위 그대로 유지된다', () => {
    const rank1 = stock({ rank: 1, ticker: 'RANK1', fluctuationsRatio: 1 });
    const rank2 = stock({ rank: 2, ticker: 'RANK2', fluctuationsRatio: 2.9 });
    const rank3 = stock({ rank: 3, ticker: 'RANK3', fluctuationsRatio: -1 });

    const candidates = evaluateBuyCandidates(topResult([rank1, rank2, rank3]), [], 'marketcap', NO_BUFFERS);

    expect(candidates.map((c) => c.stock.ticker)).toEqual(['RANK1', 'RANK2', 'RANK3']);
  });

  it('경계값: 정확히 3.00%는(연속상승 확인 시) 급등 버킷에 포함된다', () => {
    const rank5 = stock({ rank: 5, ticker: 'RANK5', fluctuationsRatio: 3.0 });
    const rank1 = stock({ rank: 1, ticker: 'RANK1', fluctuationsRatio: 0 });
    const buffers = new Map([['RANK5', confirmedBuffer(3.0)]]);

    const candidates = evaluateBuyCandidates(topResult([rank1, rank5]), [], 'marketcap', buffers);

    expect(candidates.map((c) => c.stock.ticker)).toEqual(['RANK5', 'RANK1']);
  });

  it('이미 보유 중인 종목은 급등해도 후보에서 제외된다 (재분배는 B4 담당)', () => {
    const held = stock({ rank: 2, ticker: 'HELD', fluctuationsRatio: 10 });
    const unheld = stock({ rank: 1, ticker: 'UNHELD', fluctuationsRatio: 0 });

    const candidates = evaluateBuyCandidates(
      topResult([unheld, held]),
      [{ ticker: 'HELD' } as any],
      'marketcap',
      NO_BUFFERS,
    );

    expect(candidates.map((c) => c.stock.ticker)).toEqual(['UNHELD']);
  });

  it('상한(8%) 초과 급등 종목은 연속상승 확인돼도 우선 버킷에서 제외되고 일반 순서로 밀린다 (상투매수 방지)', () => {
    const rank1 = stock({ rank: 1, ticker: 'RANK1', fluctuationsRatio: 0.5 });
    const overExtended = stock({ rank: 6, ticker: 'OVEREXT', fluctuationsRatio: 12 }); // > 8%
    const withinBand = stock({ rank: 9, ticker: 'INBAND', fluctuationsRatio: 5 }); // 3~8%
    const buffers = new Map([
      ['OVEREXT', confirmedBuffer(12)],
      ['INBAND', confirmedBuffer(5)],
    ]);

    const candidates = evaluateBuyCandidates(
      topResult([rank1, overExtended, withinBand]),
      [],
      'marketcap',
      buffers,
    );

    // 밴드 안(INBAND)만 우선, OVEREXT 는 일반 버킷에서 원래 순위(RANK1 다음)로.
    expect(candidates.map((c) => c.stock.ticker)).toEqual(['INBAND', 'RANK1', 'OVEREXT']);
    expect(candidates.find((c) => c.stock.ticker === 'OVEREXT')?.reason).toContain('신규 진입');
  });

  it('경계값: 정확히 8.00%는(연속상승 확인 시) 여전히 급등 버킷에 포함된다', () => {
    const rank1 = stock({ rank: 1, ticker: 'RANK1', fluctuationsRatio: 0 });
    const atMax = stock({ rank: 5, ticker: 'ATMAX', fluctuationsRatio: 8.0 });
    const buffers = new Map([['ATMAX', confirmedBuffer(8.0)]]);

    const candidates = evaluateBuyCandidates(topResult([rank1, atMax]), [], 'marketcap', buffers);

    expect(candidates.map((c) => c.stock.ticker)).toEqual(['ATMAX', 'RANK1']);
  });
});

describe('isSteadyRiser — 연속상승 확인 (v6.1.4)', () => {
  it('5개 미만 샘플이면 아직 판단 불가', () => {
    expect(isSteadyRiser([1, 1.5, 2])).toBe(false);
  });

  it('5분 연속 꺾이지 않고 충분히(1.5%+) 올랐으면 확인', () => {
    expect(isSteadyRiser([0.5, 1, 1.8, 2.5, 3.2])).toBe(true); // 총 +2.7%
  });

  it('연속 상승이어도 상승폭이 너무 작으면(노이즈) 탈락', () => {
    expect(isSteadyRiser([1.0, 1.1, 1.15, 1.2, 1.3])).toBe(false); // 총 +0.3%
  });

  it('중간에 한 번이라도 꺾이면 탈락 — 마지막 5개 구간 기준', () => {
    expect(isSteadyRiser([0.5, 3.0, 1.0, 1.5, 2.0, 2.8])).toBe(false); // 최근5개: 3.0→1.0 하락 포함
  });

  it('꺾인 구간이 윈도우 밖으로 밀려나면 다시 확인 가능', () => {
    // 오래된 하락(5.0→1.0)은 최근 5개 샘플에 안 잡히고, 최근 5개는 꾸준히 상승
    expect(isSteadyRiser([5.0, 1.0, 1.5, 2.0, 2.5, 3.0])).toBe(true);
  });

  it('평평하게 유지(상승 없음)면 탈락', () => {
    expect(isSteadyRiser([2, 2, 2, 2, 2])).toBe(false);
  });
});

describe('findSwapSellTarget — 급등 매수 재원 확보용 스왑매도 (v6.1.4)', () => {
  function position(overrides: Record<string, any>) {
    return {
      stock_id: 1,
      ticker: 'X',
      name: '테스트종목',
      qty: 1,
      avg_price: 10000,
      currentPrice: 10000,
      locked: false,
      ...overrides,
    } as any;
  }

  it('손실 비율이 아니라 손실 "금액"이 가장 작은 종목을 고른다', () => {
    // A: -1000원(1주, -10%) / B: -500원(1주, -5%) → 금액 기준으론 B가 더 작음
    const a = position({ ticker: 'A', avg_price: 10000, currentPrice: 9000, qty: 1 });
    const b = position({ ticker: 'B', avg_price: 10000, currentPrice: 9500, qty: 1 });
    const rankMap = new Map([['A', 10], ['B', 10]]); // 둘 다 후보(랭킹8)보다 나쁨 — 스왑 대상 자격

    const result = findSwapSellTarget([a, b], new Set(), rankMap, /* candidateRank */ 8, new Set());

    expect(result?.position.ticker).toBe('B');
  });

  it('손실률이 SWAP_SELL_MAX_LOSS_PCT(5%)를 초과하면 손실액이 작아도 제외된다', () => {
    // C: -600원이지만 대량 보유라 손실률 -60%(백스탑 초과) → 제외돼야 함
    // D: -800원, 손실률 -4%(백스탑 이내) → 손실액은 더 크지만 유일한 유효 후보
    const c = position({ ticker: 'C', avg_price: 1000, currentPrice: 400, qty: 1 }); // -600원, -60%
    const d = position({ ticker: 'D', avg_price: 20000, currentPrice: 19200, qty: 1 }); // -800원, -4%
    const rankMap = new Map([['C', 10], ['D', 10]]); // 둘 다 후보(랭킹8)보다 나쁨

    const result = findSwapSellTarget([c, d], new Set(), rankMap, 8, new Set());

    expect(result?.position.ticker).toBe('D');
  });

  it('시총(현재 랭킹)이 후보보다 좋은(숫자가 작은) 종목은 스왑 대상에서 제외된다', () => {
    // BETTER: 랭킹 2(후보 랭킹 8보다 좋음) → 제외
    // WORSE: 랭킹 15(후보보다 나쁨) → 대상
    const better = position({ ticker: 'BETTER', avg_price: 10000, currentPrice: 9800, qty: 1 });
    const worse = position({ ticker: 'WORSE', avg_price: 10000, currentPrice: 9500, qty: 1 });
    const rankMap = new Map([['BETTER', 2], ['WORSE', 15]]);

    const result = findSwapSellTarget([better, worse], new Set(), rankMap, /* candidateRank */ 8, new Set());

    expect(result?.position.ticker).toBe('WORSE');
  });

  it('거래 고정(locked) 종목은 손실이 작아도 스왑 대상에서 제외된다', () => {
    const locked = position({ ticker: 'LOCKED', avg_price: 10000, currentPrice: 9900, qty: 1 });
    const normal = position({ ticker: 'NORMAL', avg_price: 10000, currentPrice: 9800, qty: 1 }); // -2%, 백스탑 이내
    const rankMap = new Map([['LOCKED', 10], ['NORMAL', 10]]); // 둘 다 후보(랭킹8)보다 나쁨

    const result = findSwapSellTarget([locked, normal], new Set(['LOCKED']), rankMap, 8, new Set());

    expect(result?.position.ticker).toBe('NORMAL');
  });

  it('수익 중인 종목은 스왑 대상이 아니다', () => {
    const profitable = position({ ticker: 'PROFIT', avg_price: 10000, currentPrice: 11000, qty: 1 });
    const rankMap = new Map([['PROFIT', 5]]);

    const result = findSwapSellTarget([profitable], new Set(), rankMap, 8, new Set());

    expect(result).toBeNull();
  });

  it('이미 이번 사이클에 스왑한 종목(excludeTickers)은 다시 뽑히지 않는다', () => {
    const onlyLoser = position({ ticker: 'ONLY', avg_price: 10000, currentPrice: 9500, qty: 1 });
    const rankMap = new Map([['ONLY', 10]]); // 후보(랭킹8)보다 나쁨 — rank 는 문제 없음, exclude만 검증

    const result = findSwapSellTarget([onlyLoser], new Set(), rankMap, 8, new Set(['ONLY']));

    expect(result).toBeNull();
  });

  it('랭킹 정보가 없는(Top30 이탈) 보유종목은 항상 스왑 대상 후보가 된다', () => {
    const fallenOut = position({ ticker: 'FALLEN', avg_price: 10000, currentPrice: 9800, qty: 1 });
    const rankMap = new Map<string, number>(); // FALLEN 없음 → 999 취급

    const result = findSwapSellTarget([fallenOut], new Set(), rankMap, 8, new Set());

    expect(result?.position.ticker).toBe('FALLEN');
  });
});
