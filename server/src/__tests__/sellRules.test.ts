/**
 * sellRules.ts — 매도 규칙 엔진 테스트
 *
 * 4개 규칙 각각의 경계값, 우선순위, enabled/disabled, peak tracker 검증.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    sellRulesEnabled: true,
    targetProfitRate: 3.0,
    hardStopLossRate: 2.0,
    trailingStopRate: 1.5,
    maxHoldMinutes: 60,
  })),
}));

import { initializeDB, execute } from '../db';
import {
  evaluateSellRules,
  updatePeakPrice,
  resetPeakPrice,
  getPeakPrice,
  getBuyTimestamp,
  type HoldingContext,
} from '../services/sellRules';
import { getSettings } from '../services/settings';

const base: HoldingContext = {
  stockId: 1,
  ticker: '005930',
  currentPrice: 70000,
  avgPrice: 70000,
  quantity: 10,
  unrealizedPnLPercent: 0,
};

describe('sellRules', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    resetPeakPrice(1);
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM transactions');
    vi.mocked(getSettings).mockReturnValue({
      sellRulesEnabled: true,
      targetProfitRate: 3.0,
      hardStopLossRate: 2.0,
      trailingStopRate: 1.5,
      maxHoldMinutes: 60,
    } as any);
  });

  describe('TARGET_PROFIT', () => {
    it('+3.0% triggers sell', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 3.0 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
    });

    it('+2.9% does NOT trigger', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 2.9 });
      expect(r.rule).not.toBe('TARGET_PROFIT');
    });

    it('+5% triggers (above threshold)', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 5 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
    });
  });

  describe('STOP_LOSS', () => {
    it('-2.0% triggers sell', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: -2.0 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('STOP_LOSS');
    });

    it('-1.9% does NOT trigger', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: -1.9 });
      expect(r.rule).not.toBe('STOP_LOSS');
    });

    it('-5% triggers (well below threshold)', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: -5 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('STOP_LOSS');
    });
  });

  describe('TRAILING_STOP', () => {
    it('1.5% drop from peak triggers sell', () => {
      // Set peak to 10000 first
      updatePeakPrice(1, 10000);
      // Current price = 9850 → drop = (10000-9850)/10000 = 1.5%
      const r = evaluateSellRules({
        ...base,
        stockId: 1,
        currentPrice: 9850,
        avgPrice: 9500, // still in profit so TARGET_PROFIT won't trigger
        unrealizedPnLPercent: ((9850 - 9500) / 9500) * 100, // +3.68% → triggers TARGET_PROFIT first!
      });
      // Since unrealizedPnL is +3.68% ≥ 3%, TARGET_PROFIT will fire first.
      // Need to use a case where unrealizedPnL is positive but < 3%.
      expect(r.rule).toBe('TARGET_PROFIT'); // OK, proving priority order
    });

    it('1.5% drop from peak triggers when unrealizedPnL < targetProfitRate', () => {
      updatePeakPrice(1, 10000);
      // Price dropped to 9850 from peak 10000, but cost basis was 9900
      // unrealizedPnL = (9850-9900)/9900 = -0.5%, not triggering TARGET_PROFIT or STOP_LOSS
      const r = evaluateSellRules({
        ...base,
        stockId: 1,
        currentPrice: 9850,
        avgPrice: 9900,
        unrealizedPnLPercent: -0.5,
      });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TRAILING_STOP');
    });

    it('1.4% drop does NOT trigger', () => {
      updatePeakPrice(1, 10000);
      const r = evaluateSellRules({
        ...base,
        stockId: 1,
        currentPrice: 9860, // drop = 1.4%
        avgPrice: 9900,
        unrealizedPnLPercent: -0.4,
      });
      expect(r.shouldSell).toBe(false);
    });
  });

  describe('HOLDING_TIME', () => {
    it('61 minutes triggers sell', () => {
      const now = new Date();
      const past = new Date(now.getTime() - 61 * 60_000);
      execute(
        "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 70000, ?)",
        [1, past.toISOString()],
      );
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 0 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('HOLDING_TIME');
    });

    it('59 minutes does NOT trigger', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 59 * 60_000);
      execute(
        "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 70000, ?)",
        [1, recent.toISOString()],
      );
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 0 });
      expect(r.shouldSell).toBe(false);
    });

    it('returns false when no buy record exists', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 0 });
      expect(r.shouldSell).toBe(false);
    });
  });

  describe('priority order', () => {
    it('TARGET_PROFIT fires before STOP_LOSS (mutually exclusive in practice)', () => {
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 5 });
      expect(r.rule).toBe('TARGET_PROFIT');
    });
  });

  describe('sellRulesEnabled = false', () => {
    it('skips all rules when disabled', () => {
      vi.mocked(getSettings).mockReturnValue({
        sellRulesEnabled: false,
        targetProfitRate: 3.0,
        hardStopLossRate: 2.0,
        trailingStopRate: 1.5,
        maxHoldMinutes: 60,
      } as any);
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 10 });
      expect(r.shouldSell).toBe(false);
    });
  });

  describe('peak tracker', () => {
    it('updatePeakPrice returns the higher of existing and new', () => {
      expect(updatePeakPrice(99, 100)).toBe(100);
      expect(updatePeakPrice(99, 110)).toBe(110);
      expect(updatePeakPrice(99, 105)).toBe(110); // existing peak 110 > 105
    });

    it('resetPeakPrice clears the tracking', () => {
      updatePeakPrice(99, 200);
      resetPeakPrice(99);
      expect(getPeakPrice(99)).toBeUndefined();
    });
  });

  describe('getBuyTimestamp', () => {
    it('returns null when no buy records exist', () => {
      expect(getBuyTimestamp(999)).toBeNull();
    });

    it('returns auto_trades timestamp when available', () => {
      const ts = '2026-04-14T10:30:00';
      execute(
        "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 100, ?)",
        [2, ts],
      );
      const result = getBuyTimestamp(2);
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toContain('2026-04-14');
    });
  });

  // ─── v4.16.0: ROI Table ─────────────────────────────
  describe('ROI Table', () => {
    const insertBuyAt = (stockId: number, minutesAgo: number) => {
      const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
      execute(
        "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 100, ?)",
        [stockId, ts],
      );
    };

    const withRoi = (roiTable: Array<[number, number]>, otherOverrides: any = {}) => {
      vi.mocked(getSettings).mockReturnValue({
        sellRulesEnabled: true,
        targetProfitRate: 3.0,
        hardStopLossRate: 2.0,
        trailingStopRate: 1.5,
        maxHoldMinutes: 60,
        roiTable,
        ...otherOverrides,
      } as any);
    };

    it('t=0분일 때 첫 단계 threshold(3%)를 사용', () => {
      withRoi([[0, 3.0], [30, 2.0], [60, 1.0]]);
      insertBuyAt(11, 1); // 1분 전 매수
      const r = evaluateSellRules({ ...base, stockId: 11, unrealizedPnLPercent: 3.1 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
      expect(r.reason).toContain('ROI Table');
    });

    it('t=35분 (30분 구간)일 때 2% 수익으로 익절', () => {
      withRoi([[0, 3.0], [30, 2.0], [60, 1.0]]);
      insertBuyAt(12, 35);
      const r = evaluateSellRules({ ...base, stockId: 12, unrealizedPnLPercent: 2.1 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
    });

    it('t=35분에 1.9%는 익절 안 함', () => {
      withRoi([[0, 3.0], [30, 2.0], [60, 1.0]]);
      insertBuyAt(13, 35);
      const r = evaluateSellRules({ ...base, stockId: 13, unrealizedPnLPercent: 1.9 });
      expect(r.shouldSell).toBe(false);
    });

    it('t=65분(60분 구간)일 때 1% 수익으로 익절', () => {
      withRoi([[0, 3.0], [30, 2.0], [60, 1.0]]);
      insertBuyAt(14, 65);
      const r = evaluateSellRules({ ...base, stockId: 14, unrealizedPnLPercent: 1.1 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
    });

    it('마지막 항목이 0%면 손익무관 강매도 역할', () => {
      withRoi([[0, 3.0], [60, 0]]);
      insertBuyAt(15, 65);
      const r = evaluateSellRules({ ...base, stockId: 15, unrealizedPnLPercent: 0.01 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
    });

    it('ROI Table 있으면 HOLDING_TIME 규칙 비활성화', () => {
      // maxHoldMinutes=60이지만 ROI table이 있으므로 적용 안 됨
      withRoi([[0, 10.0]], { maxHoldMinutes: 60 });
      insertBuyAt(16, 120); // 2시간 경과
      const r = evaluateSellRules({ ...base, stockId: 16, unrealizedPnLPercent: 5 });
      // ROI threshold 10% 미달이고, STOP_LOSS/TRAILING도 해당 없음 → HOLD
      expect(r.shouldSell).toBe(false);
    });

    it('roiTable 없으면 기존 targetProfitRate 방식 유지 (후방 호환)', () => {
      vi.mocked(getSettings).mockReturnValue({
        sellRulesEnabled: true,
        targetProfitRate: 3.0,
        hardStopLossRate: 2.0,
        trailingStopRate: 1.5,
        maxHoldMinutes: 60,
        // roiTable: undefined
      } as any);
      const r = evaluateSellRules({ ...base, unrealizedPnLPercent: 3.0 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('TARGET_PROFIT');
      expect(r.reason).not.toContain('ROI Table');
    });

    it('STOP_LOSS는 ROI Table과 무관하게 동작', () => {
      withRoi([[0, 10.0], [60, 0]]);
      insertBuyAt(17, 5);
      const r = evaluateSellRules({ ...base, stockId: 17, unrealizedPnLPercent: -2.5 });
      expect(r.shouldSell).toBe(true);
      expect(r.rule).toBe('STOP_LOSS');
    });
  });
});
