/**
 * stockScreener.ts — 동적 스크리닝 엔진 테스트
 *
 * 국면 판별, 스코어링, 중복 방지 검증.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    dynamicScreeningEnabled: true,
    screeningVolumeRatioMin: 1.5,
    screeningMinMarketCap: 500,
  })),
}));

vi.mock('../services/stockPrice', () => ({
  getMarketContext: vi.fn(async () => ({
    kospi: { price: 2600, changePercent: 0 },
    kosdaq: { price: 850, changePercent: 0 },
  })),
}));

vi.mock('../db', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(() => null),
  execute: vi.fn(),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  determineMarketPhase,
  scoreCandidate,
  runDynamicScreening,
  resetScreenerDedup,
} from '../services/stockScreener';
import { getMarketContext } from '../services/stockPrice';
import { getSettings } from '../services/settings';

describe('determineMarketPhase', () => {
  it('returns RISING when avg >= +0.5%', () => {
    expect(determineMarketPhase(0.8, 0.4)).toBe('RISING');
    expect(determineMarketPhase(0.5, 0.5)).toBe('RISING');
  });

  it('returns FALLING when avg <= -0.5%', () => {
    expect(determineMarketPhase(-0.6, -0.4)).toBe('FALLING');
    expect(determineMarketPhase(-1.0, -0.5)).toBe('FALLING');
  });

  it('returns FLAT when avg is between -0.5 and +0.5', () => {
    expect(determineMarketPhase(0.3, -0.1)).toBe('FLAT');
    expect(determineMarketPhase(0.0, 0.0)).toBe('FLAT');
    expect(determineMarketPhase(0.4, 0.4)).toBe('FLAT');
    expect(determineMarketPhase(-0.4, -0.4)).toBe('FLAT');
  });

  it('boundary: avg exactly 0.5 → RISING', () => {
    expect(determineMarketPhase(0.5, 0.5)).toBe('RISING');
  });

  it('boundary: avg exactly -0.5 → FALLING', () => {
    expect(determineMarketPhase(-0.5, -0.5)).toBe('FALLING');
  });
});

describe('scoreCandidate', () => {
  it('returns max scores for ideal candidate', () => {
    const s = scoreCandidate(3, 3, 50, 10000);
    expect(s.volumeScore).toBe(30);    // (3-1)*15 = 30
    expect(s.momentumScore).toBe(30);  // 3*10 = 30
    expect(s.rsiScore).toBe(20);       // |50-50| = 0, 20-0 = 20
    expect(s.capScore).toBe(20);       // (10000-500)/225 >> 20, capped at 20
    expect(s.total).toBe(100);
  });

  it('returns 0 for worst candidate', () => {
    const s = scoreCandidate(0, 1, 0, 0);
    expect(s.volumeScore).toBe(0);     // (1-1)*15 = 0
    expect(s.momentumScore).toBe(0);   // 0*10 = 0
    expect(s.rsiScore).toBe(0);        // |0-50| = 50 → max(0, 20-50) = 0
    expect(s.capScore).toBe(0);        // (0-500)/225 → negative → 0
    expect(s.total).toBe(0);
  });

  it('gives neutral RSI score when null', () => {
    const s = scoreCandidate(1, 1.5, null, 1000);
    expect(s.rsiScore).toBe(10); // null → 중립 10점
  });

  it('momentum capped at 30', () => {
    const s = scoreCandidate(10, 1, 50, 0);
    expect(s.momentumScore).toBe(30); // 10*10=100 → capped 30
  });
});

describe('runDynamicScreening', () => {
  beforeEach(() => {
    resetScreenerDedup();
    vi.clearAllMocks();
  });

  it('returns skipped when dynamicScreeningEnabled=false', async () => {
    vi.mocked(getSettings).mockReturnValue({
      dynamicScreeningEnabled: false,
      screeningVolumeRatioMin: 1.5,
      screeningMinMarketCap: 500,
    } as any);

    const result = await runDynamicScreening('KRX');
    expect(result.candidates).toEqual([]);
    expect(result.skippedReason).toMatch(/비활성화/);
  });

  it('returns empty candidates with FALLING reason', async () => {
    vi.mocked(getMarketContext).mockResolvedValue({
      kospi: { price: 2600, changePercent: -1.0 },
      kosdaq: { price: 850, changePercent: -0.5 },
    });
    vi.mocked(getSettings).mockReturnValue({
      dynamicScreeningEnabled: true,
      screeningVolumeRatioMin: 1.5,
      screeningMinMarketCap: 500,
    } as any);

    const result = await runDynamicScreening('KRX');
    expect(result.phase).toBe('FALLING');
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedReason).toMatch(/FALLING/);
  });

  it('returns RISING phase when indices are up', async () => {
    vi.mocked(getMarketContext).mockResolvedValue({
      kospi: { price: 2600, changePercent: 0.8 },
      kosdaq: { price: 850, changePercent: 0.6 },
    });
    vi.mocked(getSettings).mockReturnValue({
      dynamicScreeningEnabled: true,
      screeningVolumeRatioMin: 1.5,
      screeningMinMarketCap: 500,
    } as any);

    // No DB stocks, so candidates will be empty but phase should be RISING
    const result = await runDynamicScreening('KRX');
    expect(result.phase).toBe('RISING');
  });
});
