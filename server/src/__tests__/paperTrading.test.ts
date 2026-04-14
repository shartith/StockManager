/**
 * paperTrading.ts — 가상매매 엔진 테스트
 *
 * 핵심 시나리오:
 *   - autoCreatePaperBuy: 정상 생성, 실 종목 중복 시 skip, 이미 가상보유 시 skip,
 *     paperTradingEnabled=false 시 skip, 가격 0 시 skip
 *   - getPaperHoldings: BUY/SELL pair 잔여 수량 정확
 *   - executePaperSell: P&L 계산 + pair_id 연결
 *   - hasRealHolding: transactions/auto_trades 양쪽 합산
 *   - 100만원 기준 qty 계산 (KRW 종목)
 *   - 해외 종목 환율 환산 (USD → KRW)
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    paperTradingEnabled: true,
    paperTradeAmount: 1_000_000,
  })),
}));

vi.mock('../services/stockPrice', () => ({
  getMarketContext: vi.fn(async () => ({
    usdKrw: { price: 1400, changePercent: 0 },
  })),
}));

import { initializeDB, queryAll, queryOne, execute } from '../db';
import {
  autoCreatePaperBuy,
  getPaperHoldings,
  executePaperSell,
  hasRealHolding,
  getPaperSummary,
} from '../services/paperTrading';
import { getSettings } from '../services/settings';

function insertStock(id: number, ticker = '005930', market = 'KRX'): void {
  execute(
    'INSERT INTO stocks (id, ticker, name, market, sector) VALUES (?, ?, ?, ?, ?)',
    [id, ticker, '삼성전자', market, '반도체'],
  );
}

describe('paperTrading', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM paper_trades');
    execute('DELETE FROM transactions');
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM stocks');
    vi.mocked(getSettings).mockReturnValue({
      paperTradingEnabled: true,
      paperTradeAmount: 1_000_000,
    } as any);
  });

  describe('autoCreatePaperBuy', () => {
    it('100만원 / 10,000원 = 100주 매수', async () => {
      insertStock(1);
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      expect(r.created).toBe(true);
      expect(r.quantity).toBe(100);
      const row = queryOne('SELECT * FROM paper_trades WHERE stock_id = 1');
      expect(row.order_type).toBe('BUY');
      expect(row.quantity).toBe(100);
      expect(row.price).toBe(10000);
    });

    it('100만원 / 7만원 = 14주 (floor)', async () => {
      insertStock(1);
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 70000,
      });
      expect(r.quantity).toBe(14); // floor(1,000,000 / 70,000) = 14
    });

    it('해외 종목: USD 가격 × 1400 환율 적용', async () => {
      insertStock(1, 'AAPL', 'NASDAQ');
      // AAPL 200 USD × 1400 = 280,000 KRW → 100만원 / 28만원 = 3주
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: 'AAPL', market: 'NASDAQ', currentPrice: 200,
      });
      expect(r.created).toBe(true);
      expect(r.quantity).toBe(3);
    });

    it('실매매 종목 (transactions)이면 skip', async () => {
      insertStock(1);
      execute(
        "INSERT INTO transactions (stock_id, type, quantity, price, date) VALUES (1, 'BUY', 5, 70000, '2026-04-01')",
      );
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 70000,
      });
      expect(r.created).toBe(false);
      expect(r.reason).toMatch(/실매매 종목/);
    });

    it('실매매 종목 (auto_trades FILLED)이면 skip', async () => {
      insertStock(1);
      execute(
        "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price) VALUES (1, 'BUY', 'FILLED', 5, 70000)",
      );
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 70000,
      });
      expect(r.created).toBe(false);
      expect(r.reason).toMatch(/실매매 종목/);
    });

    it('이미 가상 보유 중이면 skip (BUY 중복 금지)', async () => {
      insertStock(1);
      await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 12000,
      });
      expect(r.created).toBe(false);
      expect(r.reason).toMatch(/이미 가상 보유/);
    });

    it('paperTradingEnabled=false면 skip', async () => {
      insertStock(1);
      vi.mocked(getSettings).mockReturnValue({
        paperTradingEnabled: false,
        paperTradeAmount: 1_000_000,
      } as any);
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      expect(r.created).toBe(false);
      expect(r.reason).toMatch(/비활성화/);
    });

    it('가격이 0이면 skip', async () => {
      insertStock(1);
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 0,
      });
      expect(r.created).toBe(false);
    });

    it('가격이 paperTradeAmount보다 비싸면 skip', async () => {
      insertStock(1);
      const r = await autoCreatePaperBuy({
        stockId: 1, ticker: 'BRK.A', market: 'KRX', currentPrice: 5_000_000,
      });
      expect(r.created).toBe(false);
      expect(r.reason).toMatch(/초과/);
    });
  });

  describe('getPaperHoldings', () => {
    it('BUY 후 잔여 수량 반환', async () => {
      insertStock(1);
      await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      const holdings = getPaperHoldings();
      expect(holdings).toHaveLength(1);
      expect(holdings[0].quantity).toBe(100);
      expect(holdings[0].avgPrice).toBe(10000);
    });

    it('전량 매도 후엔 빈 배열', async () => {
      insertStock(1);
      await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      executePaperSell(1, 11000, 'TARGET_PROFIT');
      expect(getPaperHoldings()).toHaveLength(0);
    });
  });

  describe('executePaperSell', () => {
    it('P&L 계산이 정확하다 (수익)', async () => {
      insertStock(1);
      await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      const r = executePaperSell(1, 11000, 'TARGET_PROFIT');
      expect(r.sold).toBe(true);
      expect(r.pnl).toBe(100 * 1000); // 100주 × +1000원 = 100,000
      expect(r.pnlPercent).toBe(10); // +10%
    });

    it('P&L 계산 (손실)', async () => {
      insertStock(1);
      await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      const r = executePaperSell(1, 9800, 'STOP_LOSS');
      expect(r.pnl).toBe(100 * -200); // -20,000
      expect(r.pnlPercent).toBe(-2);
    });

    it('pair_id가 BUY paper_trade.id를 가리킨다', async () => {
      insertStock(1);
      const buyR = await autoCreatePaperBuy({
        stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000,
      });
      executePaperSell(1, 11000, 'TARGET_PROFIT');
      const sell = queryOne("SELECT pair_id FROM paper_trades WHERE order_type = 'SELL'");
      expect(sell.pair_id).toBe(buyR.paperTradeId);
    });

    it('BUY 없으면 매도 안 됨', () => {
      insertStock(1);
      const r = executePaperSell(1, 10000, 'TEST');
      expect(r.sold).toBe(false);
      expect(r.reason).toMatch(/BUY 기록 없음/);
    });
  });

  describe('hasRealHolding', () => {
    it('transactions BUY > SELL이면 true', () => {
      insertStock(1);
      execute("INSERT INTO transactions (stock_id, type, quantity, price, date) VALUES (1, 'BUY', 10, 100, '2026-04-01')");
      execute("INSERT INTO transactions (stock_id, type, quantity, price, date) VALUES (1, 'SELL', 5, 110, '2026-04-02')");
      expect(hasRealHolding(1)).toBe(true);
    });

    it('전량 매도되었으면 false', () => {
      insertStock(1);
      execute("INSERT INTO transactions (stock_id, type, quantity, price, date) VALUES (1, 'BUY', 10, 100, '2026-04-01')");
      execute("INSERT INTO transactions (stock_id, type, quantity, price, date) VALUES (1, 'SELL', 10, 110, '2026-04-02')");
      expect(hasRealHolding(1)).toBe(false);
    });

    it('auto_trades에만 있어도 true', () => {
      insertStock(1);
      execute("INSERT INTO auto_trades (stock_id, order_type, status, quantity, price) VALUES (1, 'BUY', 'FILLED', 5, 100)");
      expect(hasRealHolding(1)).toBe(true);
    });

    it('FAILED 주문은 보유로 인정 안 함', () => {
      insertStock(1);
      execute("INSERT INTO auto_trades (stock_id, order_type, status, quantity, price) VALUES (1, 'BUY', 'FAILED', 5, 100)");
      expect(hasRealHolding(1)).toBe(false);
    });
  });

  describe('getPaperSummary', () => {
    it('승률, 누적 P&L 정확 계산', async () => {
      insertStock(1, '005930');
      insertStock(2, '000660');

      await autoCreatePaperBuy({ stockId: 1, ticker: '005930', market: 'KRX', currentPrice: 10000 });
      executePaperSell(1, 11000, 'TARGET_PROFIT'); // +100,000원

      await autoCreatePaperBuy({ stockId: 2, ticker: '000660', market: 'KRX', currentPrice: 10000 });
      executePaperSell(2, 9800, 'STOP_LOSS'); // -20,000원

      const sum = getPaperSummary();
      expect(sum.closedTrades).toBe(2);
      expect(sum.winRate).toBe(50);
      expect(sum.totalRealizedPnL).toBe(80_000); // 100k - 20k
    });
  });
});
