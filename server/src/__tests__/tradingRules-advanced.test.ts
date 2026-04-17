/**
 * tradingRules.ts — Rule 15~21 테스트 (기존 tradingRules.test.ts 보완)
 *
 * 미커버 영역:
 *   - Rule 15: SECTOR_HEADWIND (섹터 OUT → BUY 신뢰도 -20)
 *   - Rule 16: BREADTH_DIVERGENCE (시장 건전성 경고 → BUY 차단)
 *   - Rule 17: SECTOR_TAILWIND (섹터 IN 상위 3위 → BUY 신뢰도 +15)
 *   - Rule 18: NARROW_LEADERSHIP (비주도 섹터 BUY 자제)
 *   - Rule 19: POOR_QUOTE_QUALITY (호가 품질 POOR → BUY 자제, strict → HOLD)
 *   - Rule 20: SIGNAL_COOLDOWN (30분 내 중복 BUY 차단)
 *   - Rule 21: RECENT_LOSS_PENALTY (최근 5건 중 2건+ 손실 종목 패널티)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(),
}));

import {
  applyTradingRules,
  type MarketTimeContext,
  type PriceContext,
  type SectorContext,
  type QuoteContext,
} from '../services/tradingRules';
import { queryAll, queryOne } from '../db';
import { getSettings } from '../services/settings';

// ─── 헬퍼 ─────────────────────────────────────────────────

function makeTime(o: Partial<MarketTimeContext> = {}): MarketTimeContext {
  return {
    phase: 'INTRADAY', hour: 10, minute: 30,
    isAfternoon: false, isPreClose30min: false, ...o,
  };
}

function makePrice(o: Partial<PriceContext> = {}): PriceContext {
  return {
    gapPercent: 0, intradayChangePercent: 0,
    isAtHigh: false, isAtLow: false,
    volumeRatio: 1.0, atrPercent: 2.0,
    lastCandleDirection: 'NEUTRAL', supportBroken: false,
    ...o,
  };
}

function makeSector(o: Partial<SectorContext> = {}): SectorContext {
  return {
    sectorRotation: 'NEUTRAL',
    sectorRank: 5,
    totalSectors: 10,
    breadthAdvanceDecline: 1.0,
    narrowLeadership: false,
    divergenceWarning: null,
    ...o,
  };
}

function makeQuote(o: Partial<QuoteContext> = {}): QuoteContext {
  return {
    spreadPercent: 0.1,
    depthImbalance: 0,
    topBookDepthKrw: 10_000_000,
    quality: 'GOOD',
    ...o,
  };
}

function mockRules(ids: string[]): void {
  const categoryMap: Record<string, any> = {
    SECTOR_HEADWIND: 'VOLATILITY',
    BREADTH_DIVERGENCE: 'VOLATILITY',
    SECTOR_TAILWIND: 'VOLATILITY',
    NARROW_LEADERSHIP: 'VOLATILITY',
    POOR_QUOTE_QUALITY: 'VOLUME',
    SIGNAL_COOLDOWN: 'TIME',
    RECENT_LOSS_PENALTY: 'VOLATILITY',
  };
  vi.mocked(queryAll).mockReturnValue(
    ids.map((id, i) => ({
      rule_id: id, name: id, description: '', category: categoryMap[id] || 'TIME',
      is_enabled: 1, priority: i, params_json: '{}',
    }))
  );
}

// ─── 테스트 ───────────────────────────────────────────────

describe('applyTradingRules — Rule 15~21', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockReturnValue({
      tradingRulesEnabled: true,
      tradingRulesStrictMode: false,
      gapThresholdPercent: 3, volumeSurgeRatio: 1.5,
      lowVolumeRatio: 0.7, sidewaysAtrPercent: 1.0,
    } as any);
    vi.mocked(queryOne).mockReturnValue(null);
  });

  // ─── Rule 15: SECTOR_HEADWIND ───

  describe('Rule 15: SECTOR_HEADWIND', () => {
    beforeEach(() => mockRules(['SECTOR_HEADWIND']));

    it('섹터 OUT + BUY → 신뢰도 -20', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ sectorRotation: 'OUT' })
      );
      expect(r.triggeredRules).toContain('SECTOR_HEADWIND');
      expect(r.confidenceAdjustment).toBe(-20);
    });

    it('섹터 IN → 트리거 안 함', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ sectorRotation: 'IN' })
      );
      expect(r.triggeredRules).not.toContain('SECTOR_HEADWIND');
    });

    it('HOLD 신호면 적용 안 함', () => {
      const r = applyTradingRules(
        { signal: 'HOLD', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ sectorRotation: 'OUT' })
      );
      expect(r.triggeredRules).not.toContain('SECTOR_HEADWIND');
    });

    it('sectorContext 미제공 시 스킵', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false
      );
      expect(r.triggeredRules).not.toContain('SECTOR_HEADWIND');
    });
  });

  // ─── Rule 16: BREADTH_DIVERGENCE ───

  describe('Rule 16: BREADTH_DIVERGENCE', () => {
    beforeEach(() => mockRules(['BREADTH_DIVERGENCE']));

    it('divergenceWarning 있고 BUY → HOLD 전환', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ divergenceWarning: '상승종목 감소세' })
      );
      expect(r.adjustedSignal).toBe('HOLD');
      expect(r.triggeredRules).toContain('BREADTH_DIVERGENCE');
    });

    it('divergenceWarning=null → 무시', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ divergenceWarning: null })
      );
      expect(r.triggeredRules).not.toContain('BREADTH_DIVERGENCE');
    });
  });

  // ─── Rule 17: SECTOR_TAILWIND ───

  describe('Rule 17: SECTOR_TAILWIND', () => {
    beforeEach(() => mockRules(['SECTOR_TAILWIND']));

    it('IN + 상위 3위 + BUY → +15', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ sectorRotation: 'IN', sectorRank: 2 })
      );
      expect(r.triggeredRules).toContain('SECTOR_TAILWIND');
      expect(r.confidenceAdjustment).toBe(15);
    });

    it('4위 이하면 적용 안 함', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ sectorRotation: 'IN', sectorRank: 5 })
      );
      expect(r.triggeredRules).not.toContain('SECTOR_TAILWIND');
    });
  });

  // ─── Rule 18: NARROW_LEADERSHIP ───

  describe('Rule 18: NARROW_LEADERSHIP', () => {
    beforeEach(() => mockRules(['NARROW_LEADERSHIP']));

    it('narrowLeadership + BUY + 비주도 섹터 → -15', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ narrowLeadership: true, sectorRotation: 'OUT' })
      );
      expect(r.triggeredRules).toContain('NARROW_LEADERSHIP');
      expect(r.confidenceAdjustment).toBe(-15);
    });

    it('주도 섹터(IN)면 예외 — 적용 안 함', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        makeSector({ narrowLeadership: true, sectorRotation: 'IN' })
      );
      expect(r.triggeredRules).not.toContain('NARROW_LEADERSHIP');
    });
  });

  // ─── Rule 19: POOR_QUOTE_QUALITY ───

  describe('Rule 19: POOR_QUOTE_QUALITY', () => {
    beforeEach(() => mockRules(['POOR_QUOTE_QUALITY']));

    it('POOR + BUY → -20', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined,
        makeQuote({ quality: 'POOR', spreadPercent: 1.2 })
      );
      expect(r.triggeredRules).toContain('POOR_QUOTE_QUALITY');
      expect(r.confidenceAdjustment).toBe(-20);
    });

    it('strictMode + POOR → HOLD 전환', () => {
      vi.mocked(getSettings).mockReturnValue({
        tradingRulesEnabled: true, tradingRulesStrictMode: true,
        gapThresholdPercent: 3, volumeSurgeRatio: 1.5,
        lowVolumeRatio: 0.7, sidewaysAtrPercent: 1.0,
      } as any);
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined,
        makeQuote({ quality: 'POOR' })
      );
      expect(r.adjustedSignal).toBe('HOLD');
    });

    it('GOOD 품질은 트리거 안 함', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined,
        makeQuote({ quality: 'GOOD' })
      );
      expect(r.triggeredRules).not.toContain('POOR_QUOTE_QUALITY');
    });
  });

  // ─── Rule 20: SIGNAL_COOLDOWN ───

  describe('Rule 20: SIGNAL_COOLDOWN', () => {
    beforeEach(() => mockRules(['SIGNAL_COOLDOWN']));

    it('30분 내 중복 BUY 있음 → -50 + strictMode 없어도 HOLD (총 신뢰도 <50)', () => {
      vi.mocked(queryOne).mockReturnValue({ id: 999 });
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 }, // 70 - 50 = 20 < 50 → HOLD
        makeTime(), makePrice(), false,
        undefined, undefined, 42 // stockId
      );
      expect(r.triggeredRules).toContain('SIGNAL_COOLDOWN');
      expect(r.adjustedSignal).toBe('HOLD');
    });

    it('중복 없음(queryOne null) → 트리거 안 함', () => {
      vi.mocked(queryOne).mockReturnValue(null);
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined, undefined, 42
      );
      expect(r.triggeredRules).not.toContain('SIGNAL_COOLDOWN');
    });

    it('stockId 미제공 시 쿼리 안 함', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false
      );
      expect(r.triggeredRules).not.toContain('SIGNAL_COOLDOWN');
    });

    it('높은 confidence(>100)면 -50 후에도 50+ 유지 → HOLD 안 됨 (strictMode off)', () => {
      vi.mocked(queryOne).mockReturnValue({ id: 1 });
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 100 }, // 100 - 50 = 50 → HOLD 안 됨 (50 < 50 거짓)
        makeTime(), makePrice(), false,
        undefined, undefined, 42
      );
      expect(r.triggeredRules).toContain('SIGNAL_COOLDOWN');
      expect(r.adjustedSignal).toBe('BUY');
    });
  });

  // ─── Rule 21: RECENT_LOSS_PENALTY ───

  describe('Rule 21: RECENT_LOSS_PENALTY', () => {
    beforeEach(() => mockRules(['RECENT_LOSS_PENALTY']));

    it('최근 2건 손실 → -30 (HOLD 전환 안 됨)', () => {
      vi.mocked(queryOne).mockReturnValue({ losses: 2, total: 5 });
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined, undefined, 42
      );
      expect(r.triggeredRules).toContain('RECENT_LOSS_PENALTY');
      expect(r.confidenceAdjustment).toBe(-30);
      expect(r.adjustedSignal).toBe('BUY');
    });

    it('3건+ 손실 → HOLD 전환', () => {
      vi.mocked(queryOne).mockReturnValue({ losses: 3, total: 5 });
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined, undefined, 42
      );
      expect(r.adjustedSignal).toBe('HOLD');
    });

    it('strictMode + 2건 → HOLD 전환', () => {
      vi.mocked(getSettings).mockReturnValue({
        tradingRulesEnabled: true, tradingRulesStrictMode: true,
        gapThresholdPercent: 3, volumeSurgeRatio: 1.5,
        lowVolumeRatio: 0.7, sidewaysAtrPercent: 1.0,
      } as any);
      vi.mocked(queryOne).mockReturnValue({ losses: 2, total: 5 });
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined, undefined, 42
      );
      expect(r.adjustedSignal).toBe('HOLD');
    });

    it('손실 1건 이하 → 트리거 안 함', () => {
      vi.mocked(queryOne).mockReturnValue({ losses: 1, total: 5 });
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false,
        undefined, undefined, 42
      );
      expect(r.triggeredRules).not.toContain('RECENT_LOSS_PENALTY');
    });

    it('stockId 없으면 스킵', () => {
      const r = applyTradingRules(
        { signal: 'BUY', confidence: 70 },
        makeTime(), makePrice(), false
      );
      expect(r.triggeredRules).not.toContain('RECENT_LOSS_PENALTY');
    });
  });
});
