/**
 * portfolioManager.checkPositionSizingRules — 환율 변환 회귀 테스트
 *
 * 사용자가 "해외(미국)주식이 매매되지 않는다"고 보고함. 원인은 USD 가격을
 * KRW totalValue에 1:1 비교하여 maxBuyQuantity가 거의 0이 되는 것.
 *
 * v4.10.0 수정: fxRate 파라미터 추가 → 호출처(kisOrder.executeOrder)가
 * USD→KRW 환율을 조달하여 전달.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    positionMaxRatio: 25,
    positionMinCashRatio: 20,
    positionMaxPositions: 3,
    autoTradeMaxPerStock: 2_000_000,
    autoTradeMaxInvestment: 10_000_000, // 1000만원 — getTotalPortfolioValue가 cash proxy로 사용
    portfolioMaxPerStockPercent: 20,
  })),
}));

import { initializeDB, execute } from '../db';
import { checkPositionSizingRules } from '../services/portfolioManager';

describe('checkPositionSizingRules — 환율 변환', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM transactions');
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM stocks');
  });

  it('KRX 종목: fxRate 무시 (1로 처리)', () => {
    // 1000만원 예산 × 25% = 250만원 한도, cash 1000만 × 0.9 = 900만 → buyAmount = 250만
    // 250만 / 7만(주가) = 35주
    const r = checkPositionSizingRules(70000, 'KRX', 1400);
    expect(r.allowed).toBe(true);
    expect(r.maxBuyQuantity).toBeGreaterThanOrEqual(35);
  });

  it('해외 종목: USD 가격 × 환율 적용 (수정 전엔 0이었음)', () => {
    // AAPL 200 USD → 200 × 1400 = 280,000 KRW
    // buyAmount 250만원 / 28만원 = 8주
    const r = checkPositionSizingRules(200, 'NASDAQ', 1400);
    expect(r.allowed).toBe(true);
    expect(r.maxBuyQuantity).toBeGreaterThanOrEqual(8);
    expect(r.maxBuyQuantity).toBeLessThan(15);
  });

  it('해외 종목: fxRate=1 (env 누락 fallback) 시에도 합리적 반환', () => {
    // 200 USD를 KRW로 가정하면 200원짜리 → 250만/200 = 12500주
    // 비현실적이지만 함수가 0을 반환하지 않음을 확인 (해외 매매 차단 방지)
    const r = checkPositionSizingRules(200, 'NASDAQ', 1);
    expect(r.allowed).toBe(true);
    expect(r.maxBuyQuantity).toBeGreaterThan(1000);
  });

  it('NASD alias도 해외로 인식', () => {
    const r = checkPositionSizingRules(200, 'NASD', 1400);
    expect(r.allowed).toBe(true);
    expect(r.maxBuyQuantity).toBeGreaterThanOrEqual(8);
  });

  it('빈 market 문자열은 KRW로 처리 (KRX와 동일)', () => {
    const r = checkPositionSizingRules(70000, '', 1400);
    expect(r.allowed).toBe(true);
    // 빈 문자열은 KRX와 동일하게 처리되어야 환율 안 곱해짐
    expect(r.maxBuyQuantity).toBeGreaterThanOrEqual(35);
    expect(r.maxBuyQuantity).toBeLessThan(50);
  });
});
