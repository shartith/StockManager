import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../db', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(() => null),
  execute: vi.fn(() => ({ changes: 0, lastId: 0 })),
}));
vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    autoTradeMaxInvestment: 10000000,
    autoTradeMaxPerStock: 2000000,
    portfolioMaxHoldings: 10,
    portfolioMaxPerStockPercent: 20,
    portfolioMaxSectorPercent: 40,
    portfolioMinCashPercent: 10,
    portfolioRebalanceEnabled: true,
  })),
}));
vi.mock('../services/systemEvent', () => ({
  logSystemEvent: vi.fn(),
}));
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getTotalPortfolioValue,
  checkPromotionEligibility,
  calculateOptimalQuantity,
  getRebalanceActions,
  generateRebalanceSignals,
} from '../services/portfolioManager';
import { queryAll } from '../db';
import { getSettings } from '../services/settings';

const defaultSettings = {
  autoTradeMaxInvestment: 10000000,
  autoTradeMaxPerStock: 2000000,
  portfolioMaxHoldings: 10,
  portfolioMaxPerStockPercent: 20,
  portfolioMaxSectorPercent: 40,
  portfolioMinCashPercent: 10,
  portfolioRebalanceEnabled: true,
};

describe('portfolioManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue(defaultSettings as any);
  });

  // ── getTotalPortfolioValue ──

  describe('getTotalPortfolioValue', () => {
    it('returns zero values when no holdings', () => {
      vi.mocked(queryAll).mockReturnValue([]);
      const result = getTotalPortfolioValue();
      expect(result.investedValue).toBe(0);
      expect(result.holdingCount).toBe(0);
      expect(result.totalValue).toBe(10000000); // autoTradeMaxInvestment
      expect(result.cashValue).toBe(10000000);
    });

    it('calculates invested value from holdings', () => {
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 10, sell_qty: 0, total_cost: 500000 },
        { id: 2, buy_qty: 20, sell_qty: 5, total_cost: 1000000 },
      ]);
      const result = getTotalPortfolioValue();
      // Stock 1: 10 * (500000/10) = 500000
      // Stock 2: 15 * (1000000/20) = 750000
      expect(result.investedValue).toBe(1250000);
      expect(result.holdingCount).toBe(2);
      expect(result.cashValue).toBe(8750000); // 10M - 1.25M
    });

    it('handles fully invested portfolio', () => {
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 100, sell_qty: 0, total_cost: 10000000 },
      ]);
      const result = getTotalPortfolioValue();
      expect(result.investedValue).toBe(10000000);
      expect(result.cashValue).toBe(0);
      expect(result.totalValue).toBe(10000000);
    });
  });

  // ── checkPromotionEligibility ──

  describe('checkPromotionEligibility', () => {
    it('blocks when maxHoldings exceeded', () => {
      // 10 holdings already
      vi.mocked(queryAll).mockReturnValue(
        Array.from({ length: 10 }, (_, i) => ({
          id: i + 1, buy_qty: 10, sell_qty: 0, total_cost: 500000, sector: 'IT',
        }))
      );

      const result = checkPromotionEligibility('NEW', 'KRX', 'IT');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('종목 수 초과');
    });

    it('blocks when sector concentration exceeds limit', () => {
      // Heavy AI sector allocation: 4M in AI out of 10M total = 40%
      // Adding another 2M AI stock would make 60% > 40% limit
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 20, sell_qty: 0, total_cost: 2000000, sector: 'AI', qty: 20, avg_price: 100000 },
        { id: 2, buy_qty: 20, sell_qty: 0, total_cost: 2000000, sector: 'AI', qty: 20, avg_price: 100000 },
      ]);

      const result = checkPromotionEligibility('NEWAI', 'KRX', 'AI');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('섹터');
    });

    it('blocks when cash drops below minimum', () => {
      // Holdings already consume 85% of capital
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 85, sell_qty: 0, total_cost: 8500000, sector: 'IT' },
      ]);

      // Cash is 1.5M, investing 2M would bring cash to -0.5M
      const result = checkPromotionEligibility('NEW', 'KRX', '바이오');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('현금 비율');
    });

    it('allows when all checks pass', () => {
      // 2 small holdings, plenty of cash
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 10, sell_qty: 0, total_cost: 1000000, sector: 'IT' },
        { id: 2, buy_qty: 10, sell_qty: 0, total_cost: 1000000, sector: '바이오' },
      ]);

      const result = checkPromotionEligibility('NEW', 'KRX', '에너지');
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('승격 가능');
      expect(result.currentHoldingCount).toBe(2);
      expect(result.maxHoldings).toBe(10);
    });

    it('returns correct structure with all required fields', () => {
      vi.mocked(queryAll).mockReturnValue([]);
      const result = checkPromotionEligibility('TEST', 'KRX', 'IT');

      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('availableCapital');
      expect(result).toHaveProperty('currentHoldingCount');
      expect(result).toHaveProperty('maxHoldings');
      expect(result).toHaveProperty('targetAllocation');
      expect(result).toHaveProperty('sectorExposure');
      expect(result).toHaveProperty('cashPercent');
    });

    it('respects custom maxHoldings setting', () => {
      vi.mocked(getSettings).mockReturnValue({
        ...defaultSettings,
        portfolioMaxHoldings: 3,
      } as any);

      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 10, sell_qty: 0, total_cost: 500000, sector: 'IT' },
        { id: 2, buy_qty: 10, sell_qty: 0, total_cost: 500000, sector: '바이오' },
        { id: 3, buy_qty: 10, sell_qty: 0, total_cost: 500000, sector: '금융' },
      ]);

      const result = checkPromotionEligibility('NEW', 'KRX', '에너지');
      expect(result.allowed).toBe(false);
      expect(result.maxHoldings).toBe(3);
    });
  });

  // ── calculateOptimalQuantity ──

  describe('calculateOptimalQuantity', () => {
    it('returns quantity based on portfolio percentage', () => {
      vi.mocked(queryAll).mockReturnValue([]); // no holdings → 10M total
      // 20% of 10M = 2M, price 50000 → 40 shares
      const qty = calculateOptimalQuantity(50000, 'KRX');
      expect(qty).toBe(40);
    });

    it('caps at autoTradeMaxPerStock', () => {
      vi.mocked(queryAll).mockReturnValue([]); // 10M total
      vi.mocked(getSettings).mockReturnValue({
        ...defaultSettings,
        autoTradeMaxPerStock: 1000000, // 1M cap
        portfolioMaxPerStockPercent: 50, // 50% = 5M > 1M
      } as any);

      // Should use min(1M, 5M) = 1M → 1M / 50000 = 20
      const qty = calculateOptimalQuantity(50000, 'KRX');
      expect(qty).toBe(20);
    });

    it('returns 0 for zero price', () => {
      vi.mocked(queryAll).mockReturnValue([]);
      expect(calculateOptimalQuantity(0, 'KRX')).toBe(0);
    });

    it('scales with smaller portfolio', () => {
      // Portfolio: 5M invested, total ~10M
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, buy_qty: 50, sell_qty: 0, total_cost: 5000000, sector: 'IT' },
      ]);
      // 20% of 10M = 2M (max), price 100000 → 20 shares
      const qty = calculateOptimalQuantity(100000, 'KRX');
      expect(qty).toBe(20);
    });
  });

  // ── getRebalanceActions ──

  describe('getRebalanceActions', () => {
    it('returns empty when rebalancing disabled', () => {
      vi.mocked(getSettings).mockReturnValue({
        ...defaultSettings,
        portfolioRebalanceEnabled: false,
      } as any);

      const actions = getRebalanceActions();
      expect(actions).toEqual([]);
    });

    it('returns HOLD for balanced portfolio', () => {
      // 2 holdings, each ~50% of invested value
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('GROUP BY s.id')) {
          return [
            { id: 1, ticker: 'A', name: 'A주', market: 'KRX', qty: 10, avg_price: 100000 },
            { id: 2, ticker: 'B', name: 'B주', market: 'KRX', qty: 10, avg_price: 100000 },
          ];
        }
        return [
          { id: 1, buy_qty: 10, sell_qty: 0, total_cost: 1000000, sector: 'IT' },
          { id: 2, buy_qty: 10, sell_qty: 0, total_cost: 1000000, sector: '바이오' },
        ];
      });

      const actions = getRebalanceActions();
      // Both within ±5% deviation → all HOLD
      for (const a of actions) {
        expect(a.action).toBe('HOLD');
      }
    });

    it('suggests SELL for overweight stock', () => {
      // Both queries return same data shape (holdings with qty calculation)
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, ticker: 'BIG', name: '과다', market: 'KRX', buy_qty: 80, sell_qty: 0, total_cost: 8000000, qty: 80, avg_price: 100000, sector: 'IT' },
        { id: 2, ticker: 'SML', name: '소량', market: 'KRX', buy_qty: 20, sell_qty: 0, total_cost: 2000000, qty: 20, avg_price: 100000, sector: '바이오' },
      ]);

      const actions = getRebalanceActions();
      const bigAction = actions.find(a => a.ticker === 'BIG');
      expect(bigAction).toBeDefined();
      expect(bigAction!.action).toBe('SELL');
      expect(bigAction!.adjustQuantity).toBeGreaterThan(0);
    });
  });

  // ── generateRebalanceSignals ──

  describe('generateRebalanceSignals', () => {
    it('returns 0 when no rebalancing needed', () => {
      vi.mocked(getSettings).mockReturnValue({
        ...defaultSettings,
        portfolioRebalanceEnabled: false,
      } as any);

      const result = generateRebalanceSignals();
      expect(result.generated).toBe(0);
      expect(result.actions).toEqual([]);
    });

    it('returns count of actionable items (excluding HOLD)', () => {
      vi.mocked(queryAll).mockReturnValue([
        { id: 1, ticker: 'A', name: 'A주', market: 'KRX', buy_qty: 80, sell_qty: 0, total_cost: 8000000, qty: 80, avg_price: 100000, sector: 'IT' },
        { id: 2, ticker: 'B', name: 'B주', market: 'KRX', buy_qty: 20, sell_qty: 0, total_cost: 2000000, qty: 20, avg_price: 100000, sector: '바이오' },
      ]);

      const result = generateRebalanceSignals();
      expect(result.generated).toBeGreaterThan(0);
      // Only non-HOLD actions
      for (const a of result.actions) {
        expect(a.action).not.toBe('HOLD');
      }
    });
  });
});
