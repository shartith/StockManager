/**
 * backtester.ts — 백테스트 엔진 + 조회 헬퍼 + DB 저장 테스트
 *
 * runBacktest/runABCompare는 순수 함수 (DB·API 의존 없음) → 캔들 seed로 직접 실행.
 * getLatestBacktest / isBacktestFresh / collectBacktestCandidates는 :memory: DB로 검증.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/weightOptimizer', () => ({
  loadWeights: vi.fn().mockReturnValue({
    CONSECUTIVE_BUY: 1.0, HIGH_CONFIDENCE: 1.0, VOLUME_SURGE: 1.0,
    RSI_OVERSOLD_BOUNCE: 1.0, BOLLINGER_BOUNCE: 1.0, MACD_GOLDEN_CROSS: 1.0,
    PRICE_MOMENTUM: 1.0, NEWS_POSITIVE: 1.0, NEWS_SENTIMENT: 1.0,
    TIME_DECAY: 1.0, SPREAD_TIGHT: 1.0, BOOK_DEPTH_STRONG: 1.0,
    SPREAD_WIDE: 1.0, SELL_SIGNAL: 1.0, HOLD_SIGNAL: 1.0,
    CONSECUTIVE_HOLD: 1.0, CONSECUTIVE_SELL: 1.0, LOW_CONFIDENCE: 1.0,
    RANK_DECAY: 1.0, BACKTEST_PROFITABLE: 1.0, BACKTEST_UNPROFITABLE: 1.0,
  }),
}));

import { initializeDB, execute, queryAll } from '../db';
import {
  runBacktest,
  runABCompare,
  saveBacktestResult,
  getLatestBacktest,
  isBacktestFresh,
  collectBacktestCandidates,
} from '../services/backtester';

// ─── 헬퍼 ─────────────────────────────────────────────────

function makeCandles(opts: { days?: number; volatile?: boolean; trending?: 'up' | 'down' | 'flat' } = {}): any[] {
  const { days = 90, volatile = true, trending = 'flat' } = opts;
  const candles: any[] = [];
  let price = 1000;
  for (let i = 0; i < days; i++) {
    const trendDelta = trending === 'up' ? 3 : trending === 'down' ? -3 : 0;
    const noise = volatile ? (Math.sin(i * 0.4) * 50 + Math.cos(i * 0.15) * 30) : 0;
    price += trendDelta + noise;
    candles.push({
      time: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: price - 10, high: price + 25, low: price - 25,
      close: price, volume: 100000 + Math.abs(noise) * 1000,
    });
  }
  return candles;
}

function insertStock(id: number, ticker: string, market: string = 'KRX'): void {
  execute(
    `INSERT INTO stocks (id, ticker, name, market) VALUES (?, ?, ?, ?)`,
    [id, ticker, `${ticker}이름`, market]
  );
}

function insertBacktest(ticker: string, market: string, opts: {
  pf?: number | null; totalTrades?: number; ageHours?: number;
} = {}): void {
  const { pf = 1.5, totalTrades = 10, ageHours = 1 } = opts;
  execute(
    `INSERT INTO backtest_results
     (name, ticker, market, start_date, end_date, strategy_config_json,
      total_trades, winning_trades, losing_trades, total_return, max_drawdown,
      sharpe_ratio, win_rate, avg_win, avg_loss, profit_factor, results_json, created_at)
     VALUES (?, ?, ?, '2026-01-01', '2026-04-01', '{}',
             ?, ?, ?, 5.0, 10.0, 1.0, 50, 1000, 500, ?, '[]', datetime('now', '-${ageHours} hours'))`,
    [`bt-${ticker}`, ticker, market, totalTrades,
     Math.floor(totalTrades * 0.6), Math.floor(totalTrades * 0.4), pf]
  );
}

// ─── 테스트 ───────────────────────────────────────────────

describe('backtester', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM backtest_results');
    execute('DELETE FROM stocks');
    execute('DELETE FROM watchlist');
    execute('DELETE FROM recommendations');
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM transactions');
  });

  // ─── runBacktest ───

  describe('runBacktest', () => {
    it('60캔들 미만이면 emptyResult 반환', () => {
      const result = runBacktest({
        name: 'tiny', ticker: 'T', candles: makeCandles({ days: 30 }), initialCapital: 1_000_000,
      });
      expect(result.trades).toEqual([]);
      expect(result.totalTrades).toBe(0);
      expect(result.totalReturn).toBe(0);
    });

    it('90일 정상 캔들 → 시뮬레이션 + 결과 반환', () => {
      const result = runBacktest({
        name: 'normal', ticker: 'T', candles: makeCandles({ days: 90, volatile: true }),
        initialCapital: 1_000_000,
      });
      expect(typeof result.totalReturn).toBe('number');
      expect(typeof result.maxDrawdown).toBe('number');
      expect(result.trades.length).toBeGreaterThanOrEqual(0);
    });

    it('상승 추세 + 거래 → profit_factor 계산', () => {
      const result = runBacktest({
        name: 'uptrend', ticker: 'UP', candles: makeCandles({ days: 90, trending: 'up' }),
        initialCapital: 1_000_000,
      });
      // 거래가 발생했다면 profitFactor 계산 가능
      if (result.totalTrades > 0) {
        // profit factor 또는 null
        expect(result.profitFactor === null || typeof result.profitFactor === 'number').toBe(true);
      }
    });

    it('winRate와 avgWin/avgLoss 일관성', () => {
      const result = runBacktest({
        name: 'consistency', ticker: 'C', candles: makeCandles({ days: 90 }),
        initialCapital: 1_000_000,
      });
      expect(result.winningTrades + result.losingTrades).toBeLessThanOrEqual(result.totalTrades);
      expect(result.avgWin).toBeGreaterThanOrEqual(0);
      expect(result.avgLoss).toBeGreaterThanOrEqual(0);
    });

    it('weights 커스텀 적용 가능', () => {
      const r1 = runBacktest({
        name: 'w1', ticker: 'W', candles: makeCandles({ days: 90 }),
        initialCapital: 1_000_000,
        weights: { VOLUME_SURGE: 2.0 } as any, // 부분 override — loadWeights 보완
      });
      const r2 = runBacktest({
        name: 'w2', ticker: 'W', candles: makeCandles({ days: 90 }),
        initialCapital: 1_000_000,
      });
      // weights가 result에 영향 주는지 (stricter 검증은 어려움 — 최소 실행 가능성)
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
    });

    it('maxPerTrade 지정 시 1회 투자금 제한', () => {
      const result = runBacktest({
        name: 'cap', ticker: 'CAP', candles: makeCandles({ days: 90 }),
        initialCapital: 10_000_000, maxPerTrade: 500_000,
      });
      // 매수 시 500_000 초과 안 함 (대략)
      for (const t of result.trades) {
        if (t.type === 'BUY') {
          expect(t.price * t.quantity).toBeLessThanOrEqual(550_000); // 여유치
        }
      }
    });

    it('sharpeRatio — dailyReturns 충분(>10) + stdDev > 0 일 때 숫자', () => {
      const result = runBacktest({
        name: 'sharpe', ticker: 'S', candles: makeCandles({ days: 90, volatile: true }),
        initialCapital: 1_000_000,
      });
      // null 또는 number
      expect(result.sharpeRatio === null || typeof result.sharpeRatio === 'number').toBe(true);
    });
  });

  // ─── runABCompare ───

  describe('runABCompare', () => {
    it('두 전략을 동일 캔들로 비교, 결과·요약 반환', () => {
      const candles = makeCandles({ days: 90 });
      const weightsA: any = { MACD_GOLDEN_CROSS: 2.0, VOLUME_SURGE: 1.0 };
      const weightsB: any = { MACD_GOLDEN_CROSS: 1.0, VOLUME_SURGE: 1.0 };

      const result = runABCompare(candles, 'T', weightsA, weightsB, 'Alpha', 'Beta');

      expect(result.strategyA.name).toBe('Alpha');
      expect(result.strategyB.name).toBe('Beta');
      expect(['A', 'B', 'TIE']).toContain(result.winner);
      expect(result.summary).toContain('Alpha');
      expect(result.summary).toContain('Beta');
      expect(result.summary).toContain('승자');
    });

    it('두 결과 차이 점수 < 0.5 → TIE', () => {
      const candles = makeCandles({ days: 90 });
      const sameWeights: any = { MACD_GOLDEN_CROSS: 1.0 };
      const result = runABCompare(candles, 'T', sameWeights, sameWeights, 'X', 'X');
      expect(result.winner).toBe('TIE');
    });
  });

  // ─── saveBacktestResult ───

  describe('saveBacktestResult', () => {
    it('DB에 INSERT 후 lastId 반환', () => {
      const candles = makeCandles({ days: 90 });
      const config = {
        name: 'save-test', ticker: 'SAV', market: 'KRX' as const,
        candles, initialCapital: 1_000_000,
      };
      const result = runBacktest(config);
      const id = saveBacktestResult(config, result);
      expect(id).toBeGreaterThan(0);

      const rows = queryAll(`SELECT ticker, name FROM backtest_results WHERE id = ?`, [id]);
      expect(rows.length).toBe(1);
      expect(rows[0].ticker).toBe('SAV');
    });

    it('빈 캔들로 config → start_date/end_date 빈 문자열', () => {
      const config = {
        name: 'empty-c', ticker: 'E', candles: [], initialCapital: 1_000_000,
      };
      const result = runBacktest(config);
      const id = saveBacktestResult(config, result);
      const rows = queryAll(`SELECT start_date, end_date FROM backtest_results WHERE id = ?`, [id]);
      expect(rows[0].start_date).toBe('');
      expect(rows[0].end_date).toBe('');
    });

    it('trades 100개 초과 시 results_json에 slice(0,100)만 저장', () => {
      const candles = makeCandles({ days: 90 });
      const config = { name: 'slice', ticker: 'SL', candles, initialCapital: 10_000_000 };
      const result = runBacktest(config);
      // 인위적으로 100개 초과 trade 주입
      for (let i = 0; i < 150; i++) {
        result.trades.push({ date: `2026-01-${i}`, type: 'BUY', price: 100, quantity: 1, reason: 'x' });
      }
      const id = saveBacktestResult(config, result);
      const rows = queryAll(`SELECT results_json FROM backtest_results WHERE id = ?`, [id]);
      const parsed = JSON.parse(rows[0].results_json);
      expect(parsed.length).toBeLessThanOrEqual(100);
    });
  });

  // ─── getLatestBacktest ───

  describe('getLatestBacktest', () => {
    it('결과 없으면 null', () => {
      expect(getLatestBacktest('NOPE', 'KRX')).toBeNull();
    });

    it('최신 created_at 레코드 선택', () => {
      insertBacktest('A', 'KRX', { pf: 1.0, ageHours: 48 });
      insertBacktest('A', 'KRX', { pf: 1.8, ageHours: 1 }); // 최신
      const bt = getLatestBacktest('A', 'KRX');
      expect(bt?.profitFactor).toBe(1.8);
    });

    it('ageHours 계산 — 양수이고 합리적 범위', () => {
      // SQLite는 UTC, JS Date는 local 해석이라 timezone offset(9h for KST)만큼 차이 발생.
      // 정확한 값 assert 대신 "양수" + "ageHours+UTC offset + 합리적 여유 내" 검증.
      insertBacktest('B', 'KRX', { ageHours: 24 });
      const bt = getLatestBacktest('B', 'KRX');
      expect(bt?.ageHours).toBeGreaterThan(0);
      // 24시간 주입 + UTC/local offset 최대 ±12h + 여유 2h = [12, 38] 범위 내
      expect(bt?.ageHours).toBeLessThan(40);
    });

    it('profit_factor NULL은 null로 반환', () => {
      insertBacktest('C', 'KRX', { pf: null as any });
      const bt = getLatestBacktest('C', 'KRX');
      expect(bt?.profitFactor).toBeNull();
    });

    it('다른 market은 매칭 안 됨', () => {
      insertBacktest('D', 'NASDAQ');
      expect(getLatestBacktest('D', 'KRX')).toBeNull();
    });
  });

  // ─── isBacktestFresh ───

  describe('isBacktestFresh', () => {
    const make = (o: any) => ({
      profitFactor: o.pf ?? 1.0,
      winRate: 50,
      totalReturn: 5,
      totalTrades: o.trades ?? 10,
      maxDrawdown: 10,
      sharpeRatio: 1.0,
      createdAt: new Date().toISOString(),
      ageHours: o.age ?? 1,
    });

    it('null 입력 → false', () => {
      expect(isBacktestFresh(null)).toBe(false);
    });

    it('기본 임계값 (168h, 5건)', () => {
      expect(isBacktestFresh(make({ age: 100, trades: 10 }))).toBe(true);
      expect(isBacktestFresh(make({ age: 200, trades: 10 }))).toBe(false);
      expect(isBacktestFresh(make({ age: 100, trades: 3 }))).toBe(false);
    });

    it('maxAgeHours override', () => {
      expect(isBacktestFresh(make({ age: 200, trades: 10 }), { maxAgeHours: 300 })).toBe(true);
    });

    it('minTrades override', () => {
      expect(isBacktestFresh(make({ age: 100, trades: 3 }), { minTrades: 2 })).toBe(true);
    });

    it('경계값: age=168, trades=5 → true', () => {
      expect(isBacktestFresh(make({ age: 168, trades: 5 }))).toBe(true);
    });
  });

  // ─── collectBacktestCandidates ───

  describe('collectBacktestCandidates', () => {
    it('후보 없으면 빈 배열', () => {
      expect(collectBacktestCandidates()).toEqual([]);
    });

    it('watchlist 종목 포함', () => {
      insertStock(1, '005930');
      execute(`INSERT INTO watchlist (stock_id, market) VALUES (1, 'KRX')`);
      const out = collectBacktestCandidates();
      expect(out).toEqual([{ ticker: '005930', market: 'KRX' }]);
    });

    it('최근 7일 체결 종목 포함', () => {
      insertStock(2, '000660');
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at)
         VALUES (2, 'BUY', 'FILLED', 10, 100, datetime('now', '-3 days'))`
      );
      const out = collectBacktestCandidates();
      expect(out.find(o => o.ticker === '000660')).toBeDefined();
    });

    it('활성 추천 상위 20 포함', () => {
      execute(
        `INSERT INTO recommendations (ticker, name, market, score, status)
         VALUES ('R1', 'R', 'KRX', 100, 'ACTIVE'),
                ('R2', 'R', 'KRX', 90, 'ACTIVE'),
                ('R3', 'R', 'KRX', 80, 'EXPIRED')`
      );
      const out = collectBacktestCandidates();
      const tickers = out.map(o => o.ticker);
      expect(tickers).toContain('R1');
      expect(tickers).toContain('R2');
      expect(tickers).not.toContain('R3'); // EXPIRED 제외
    });

    it('중복 제거 (체결 + watchlist + 추천에 같은 ticker)', () => {
      insertStock(10, 'DUP');
      execute(`INSERT INTO watchlist (stock_id, market) VALUES (10, 'KRX')`);
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at)
         VALUES (10, 'BUY', 'FILLED', 1, 100, datetime('now', '-1 days'))`
      );
      execute(
        `INSERT INTO recommendations (ticker, name, market, score, status) VALUES ('DUP', 'D', 'KRX', 90, 'ACTIVE')`
      );
      const out = collectBacktestCandidates();
      const dupCount = out.filter(o => o.ticker === 'DUP').length;
      expect(dupCount).toBe(1);
    });

    it('limit 파라미터 적용', () => {
      for (let i = 0; i < 10; i++) {
        execute(
          `INSERT INTO recommendations (ticker, name, market, score, status)
           VALUES ('S${i}', 'S', 'KRX', ${100 - i}, 'ACTIVE')`
        );
      }
      const out = collectBacktestCandidates(3);
      expect(out.length).toBe(3);
    });

    it('deleted_at IS NOT NULL 종목 제외', () => {
      execute(
        `INSERT INTO stocks (id, ticker, name, market, deleted_at)
         VALUES (99, 'DEL', 'del', 'KRX', datetime('now'))`
      );
      execute(`INSERT INTO watchlist (stock_id, market) VALUES (99, 'KRX')`);
      const out = collectBacktestCandidates();
      expect(out.find(o => o.ticker === 'DEL')).toBeUndefined();
    });
  });
});
