/**
 * protections.ts — Protection 시스템 테스트
 *
 * 4개 Protection rule 각각의 기본 동작, enabled/disabled, orderType 필터,
 * BacktestReject의 신선도·통계 유의성 가드 검증.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({})),
}));

import { initializeDB, execute } from '../db';
import { checkProtections, DEFAULT_PROTECTION_CONFIG } from '../services/protections';
import { getSettings } from '../services/settings';

describe('protections', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM transactions');
    execute('DELETE FROM backtest_results');
    vi.mocked(getSettings).mockReturnValue({} as any);
  });

  describe('StoplossGuard', () => {
    it('손절 이력 없으면 통과', () => {
      const r = checkProtections({ stockId: 1, ticker: 'A', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('최근 6시간 내 손절 3건이면 BUY 차단', () => {
      for (let i = 0; i < 3; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo, created_at)
           VALUES (?, 'SELL', 10, 100, 0, date('now'), '손절 (-2.5%)', datetime('now', '-1 hours'))`,
          [i + 10]
        );
      }
      const r = checkProtections({ stockId: 99, ticker: 'B', orderType: 'BUY' });
      expect(r.allowed).toBe(false);
      expect(r.protectionName).toBe('StoplossGuard');
    });

    it('SELL은 StoplossGuard 통과', () => {
      for (let i = 0; i < 5; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo, created_at)
           VALUES (?, 'SELL', 10, 100, 0, date('now'), '손절', datetime('now', '-1 hours'))`,
          [i + 10]
        );
      }
      const r = checkProtections({ stockId: 99, ticker: 'C', orderType: 'SELL' });
      expect(r.allowed).toBe(true);
    });

    it('7시간 전 손절은 포함 안 됨', () => {
      for (let i = 0; i < 3; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo, created_at)
           VALUES (?, 'SELL', 10, 100, 0, date('now'), '손절', datetime('now', '-7 hours'))`,
          [i + 10]
        );
      }
      const r = checkProtections({ stockId: 99, ticker: 'D', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });
  });

  describe('CooldownPeriod', () => {
    it('최근 거래 없으면 통과', () => {
      const r = checkProtections({ stockId: 50, ticker: 'E', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('10분 전 거래 있으면 차단', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at)
         VALUES (50, 'BUY', 'FILLED', 10, 100, datetime('now', '-10 minutes'))`
      );
      const r = checkProtections({ stockId: 50, ticker: 'E', orderType: 'BUY' });
      expect(r.allowed).toBe(false);
      expect(r.protectionName).toBe('CooldownPeriod');
    });

    it('31분 전 거래는 쿨다운 지나서 통과', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at)
         VALUES (50, 'BUY', 'FILLED', 10, 100, datetime('now', '-31 minutes'))`
      );
      const r = checkProtections({ stockId: 50, ticker: 'E', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('다른 stockId의 거래는 영향 없음', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at)
         VALUES (99, 'BUY', 'FILLED', 10, 100, datetime('now', '-5 minutes'))`
      );
      const r = checkProtections({ stockId: 50, ticker: 'E', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });
  });

  describe('LowProfitPairs', () => {
    it('거래 이력 5건 미만이면 판단 보류 (통과)', () => {
      for (let i = 0; i < 3; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo)
           VALUES (60, 'SELL', 10, 100, 0, date('now'), '익절 (+2.5%)')`
        );
      }
      const r = checkProtections({ stockId: 60, ticker: 'F', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('최근 5거래 평균 수익률 < -5% → 차단', () => {
      // StoplossGuard를 피하려고 '손절' 키워드 제외, 순수 % 표기만
      for (let i = 0; i < 5; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo, created_at)
           VALUES (60, 'SELL', 10, 100, 0, date('now'), '수익률 (-8.0%)', datetime('now', '-10 hours'))`
        );
      }
      const r = checkProtections({ stockId: 60, ticker: 'F', orderType: 'BUY' });
      expect(r.allowed).toBe(false);
      expect(r.protectionName).toBe('LowProfitPairs');
    });

    it('최근 5거래 평균 수익률 0% → 통과', () => {
      for (let i = 0; i < 5; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo)
           VALUES (60, 'SELL', 10, 100, 0, date('now'), '익절 (+0.5%)')`
        );
      }
      const r = checkProtections({ stockId: 60, ticker: 'F', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });
  });

  describe('BacktestReject', () => {
    const insertBacktest = (ticker: string, market: string, pf: number, trades: number, ageHours: number = 1) => {
      execute(
        `INSERT INTO backtest_results
         (name, ticker, market, start_date, end_date, strategy_config_json,
          total_trades, winning_trades, losing_trades, total_return, max_drawdown,
          sharpe_ratio, win_rate, avg_win, avg_loss, profit_factor, results_json, created_at)
         VALUES (?, ?, ?, '2026-01-01', '2026-04-01', '{}',
                 ?, ?, ?, 5.0, 10.0,
                 1.0, 50, 1000, 500, ?, '[]', datetime('now', '-${ageHours} hours'))`,
        [`bt-${ticker}`, ticker, market, trades, Math.floor(trades * 0.6), Math.floor(trades * 0.4), pf]
      );
    };

    it('백테스트 없으면 통과 (판단 보류)', () => {
      const r = checkProtections({ stockId: 70, ticker: 'G', market: 'KRX', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('PF=0.5 → 차단', () => {
      insertBacktest('H', 'KRX', 0.5, 10);
      const r = checkProtections({ stockId: 71, ticker: 'H', market: 'KRX', orderType: 'BUY' });
      expect(r.allowed).toBe(false);
      expect(r.protectionName).toBe('BacktestReject');
    });

    it('PF=1.2 → 통과 (임계값 0.8 초과)', () => {
      insertBacktest('I', 'KRX', 1.2, 10);
      const r = checkProtections({ stockId: 72, ticker: 'I', market: 'KRX', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('거래 3건(소표본) 이면 판단 보류', () => {
      insertBacktest('J', 'KRX', 0.3, 3); // PF 나쁘지만 샘플 부족
      const r = checkProtections({ stockId: 73, ticker: 'J', market: 'KRX', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('8일 전 백테스트는 만료되어 판단 보류', () => {
      insertBacktest('K', 'KRX', 0.2, 20, 24 * 8);
      const r = checkProtections({ stockId: 74, ticker: 'K', market: 'KRX', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('market 누락이면 스킵', () => {
      insertBacktest('L', 'KRX', 0.1, 20);
      const r = checkProtections({ stockId: 75, ticker: 'L', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });

    it('SELL은 통과', () => {
      insertBacktest('M', 'KRX', 0.1, 20);
      const r = checkProtections({ stockId: 76, ticker: 'M', market: 'KRX', orderType: 'SELL' });
      expect(r.allowed).toBe(true);
    });
  });

  describe('DEFAULT_PROTECTION_CONFIG', () => {
    it('모든 Protection이 enabled=true', () => {
      expect(DEFAULT_PROTECTION_CONFIG.stoplossGuard.enabled).toBe(true);
      expect(DEFAULT_PROTECTION_CONFIG.cooldownPeriod.enabled).toBe(true);
      expect(DEFAULT_PROTECTION_CONFIG.lowProfitPairs.enabled).toBe(true);
      expect(DEFAULT_PROTECTION_CONFIG.backtestReject.enabled).toBe(true);
    });

    it('BacktestReject 임계값이 보수적 (0.8)', () => {
      expect(DEFAULT_PROTECTION_CONFIG.backtestReject.minProfitFactor).toBe(0.8);
      expect(DEFAULT_PROTECTION_CONFIG.backtestReject.maxAgeHours).toBe(168);
      expect(DEFAULT_PROTECTION_CONFIG.backtestReject.minTrades).toBe(5);
    });
  });

  describe('사용자 override', () => {
    it('settings.protections에서 disabled 처리 가능', () => {
      vi.mocked(getSettings).mockReturnValue({
        protections: {
          stoplossGuard: { enabled: false },
          cooldownPeriod: { enabled: false },
          lowProfitPairs: { enabled: false },
          backtestReject: { enabled: false },
        },
      } as any);
      // 모든 상황에서 통과해야 함
      for (let i = 0; i < 3; i++) {
        execute(
          `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo, created_at)
           VALUES (?, 'SELL', 10, 100, 0, date('now'), '손절', datetime('now', '-1 hours'))`,
          [100 + i]
        );
      }
      const r = checkProtections({ stockId: 999, ticker: 'Z', orderType: 'BUY' });
      expect(r.allowed).toBe(true);
    });
  });
});
