/**
 * 백테스트 엔진
 * 과거 캔들 데이터에 기술적 분석 전략을 시뮬레이션하여
 * 전략 변경 전 성과를 예측한다.
 */

import { queryOne, execute } from '../db';
import { analyzeTechnical, CandleData } from './technicalAnalysis';
import { loadWeights } from './weightOptimizer';
import { ScoreType } from './scoring';

export interface BacktestConfig {
  name: string;
  ticker?: string;
  market?: 'KRX' | 'NYSE' | 'NASDAQ';
  candles: CandleData[];          // 외부에서 주입
  initialCapital: number;
  weights?: Record<ScoreType, number>;
  maxPerTrade?: number;           // 1회 최대 투자금
}

export interface BacktestTrade {
  date: string;
  type: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  reason: string;
  pnl?: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalReturn: number;
  maxDrawdown: number;
  winRate: number;
  sharpeRatio: number | null;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
}

/** 백테스트 실행 (기술적 분석 기반, LLM 미사용) */
export function runBacktest(config: BacktestConfig): BacktestResult {
  const { candles, initialCapital } = config;
  const weights = config.weights || loadWeights();
  const maxPerTrade = config.maxPerTrade || initialCapital * 0.2;

  if (candles.length < 60) {
    return emptyResult();
  }

  let cash = initialCapital;
  let holdings = 0;
  let avgCost = 0;
  let peakValue = initialCapital;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];
  const dailyReturns: number[] = [];
  let prevPortfolioValue = initialCapital;

  // 최소 30일 워밍업 후 시뮬레이션 시작
  for (let i = 30; i < candles.length; i++) {
    const windowCandles = candles.slice(0, i + 1);
    const indicators = analyzeTechnical(windowCandles);
    const today = candles[i];
    const price = today.close;

    // 포트폴리오 가치
    const portfolioValue = cash + holdings * price;
    const dailyReturn = (portfolioValue - prevPortfolioValue) / prevPortfolioValue;
    dailyReturns.push(dailyReturn);
    prevPortfolioValue = portfolioValue;

    // 최대 낙폭 계산
    if (portfolioValue > peakValue) peakValue = portfolioValue;
    const drawdown = ((peakValue - portfolioValue) / peakValue) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // 매수 신호 판정 (가중치 적용)
    let buyScore = 0;
    const reasons: string[] = [];

    if (indicators.rsi14 !== null && indicators.rsi14 >= 30 && indicators.rsi14 <= 40) {
      buyScore += 15 * (weights.RSI_OVERSOLD_BOUNCE || 1);
      reasons.push('RSI 과매도 반등');
    }
    if (indicators.macdHistogram && indicators.macdHistogram > 0 && indicators.macd && indicators.macd > 0) {
      buyScore += 20 * (weights.MACD_GOLDEN_CROSS || 1);
      reasons.push('MACD 골든크로스');
    }
    if (indicators.bollingerLower && indicators.bollingerMiddle &&
        price > indicators.bollingerLower && price < indicators.bollingerMiddle) {
      const dist = ((price - indicators.bollingerLower) / indicators.bollingerLower) * 100;
      if (dist < 3) {
        buyScore += 10 * (weights.BOLLINGER_BOUNCE || 1);
        reasons.push('볼린저 하단 반등');
      }
    }

    // 거래량 급증 체크
    if (i >= 20) {
      const avgVol = candles.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20;
      if (today.volume > avgVol * 1.5) {
        buyScore += 15 * (weights.VOLUME_SURGE || 1);
        reasons.push('거래량 급증');
      }
    }

    // 매수 실행 (score >= 30 && 미보유)
    if (buyScore >= 30 && holdings === 0 && cash > price) {
      const investAmount = Math.min(maxPerTrade, cash);
      const qty = Math.floor(investAmount / price);
      if (qty > 0) {
        holdings = qty;
        avgCost = price;
        cash -= qty * price;
        trades.push({ date: today.time, type: 'BUY', price, quantity: qty, reason: reasons.join(', ') });
      }
    }

    // 매도 판정 (보유 중)
    if (holdings > 0) {
      const pnlPct = ((price - avgCost) / avgCost) * 100;
      let sellReason = '';

      // 목표 수익 도달 (+5%)
      if (pnlPct >= 5) {
        sellReason = `이익실현 (+${pnlPct.toFixed(1)}%)`;
      }
      // 손절 (-3%)
      else if (pnlPct <= -3) {
        sellReason = `손절 (${pnlPct.toFixed(1)}%)`;
      }
      // RSI 과매수
      else if (indicators.rsi14 !== null && indicators.rsi14 >= 75) {
        sellReason = `RSI 과매수 (${indicators.rsi14.toFixed(1)})`;
      }
      // MACD 데드크로스
      else if (indicators.macdHistogram && indicators.macdHistogram < 0 && indicators.macd && indicators.macd < 0 && pnlPct > 0) {
        sellReason = 'MACD 데드크로스 + 수익 확보';
      }

      if (sellReason) {
        const pnl = (price - avgCost) * holdings;
        trades.push({ date: today.time, type: 'SELL', price, quantity: holdings, reason: sellReason, pnl });
        cash += holdings * price;
        holdings = 0;
        avgCost = 0;
      }
    }
  }

  // 마지막 보유분 강제 청산
  if (holdings > 0) {
    const lastPrice = candles[candles.length - 1].close;
    const pnl = (lastPrice - avgCost) * holdings;
    trades.push({ date: candles[candles.length - 1].time, type: 'SELL', price: lastPrice, quantity: holdings, reason: '백테스트 종료 청산', pnl });
    cash += holdings * lastPrice;
    holdings = 0;
  }

  // 통계 계산
  const sellTrades = trades.filter(t => t.type === 'SELL' && t.pnl !== undefined);
  const winningTrades = sellTrades.filter(t => (t.pnl || 0) > 0);
  const losingTrades = sellTrades.filter(t => (t.pnl || 0) <= 0);
  const totalReturn = ((cash - initialCapital) / initialCapital) * 100;

  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((s, t) => s + (t.pnl || 0), 0) / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((s, t) => s + (t.pnl || 0), 0) / losingTrades.length) : 0;
  const grossWin = winningTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + (t.pnl || 0), 0));

  // 샤프 비율
  let sharpeRatio: number | null = null;
  if (dailyReturns.length > 10) {
    const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpeRatio = Math.round((avgReturn / stdDev) * Math.sqrt(252) * 100) / 100;
    }
  }

  return {
    trades,
    totalReturn: Math.round(totalReturn * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    winRate: sellTrades.length > 0 ? Math.round((winningTrades.length / sellTrades.length) * 100) : 0,
    sharpeRatio,
    avgWin: Math.round(avgWin),
    avgLoss: Math.round(avgLoss),
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    totalTrades: sellTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
  };
}

/** 백테스트 결과 DB 저장 */
export function saveBacktestResult(config: BacktestConfig, result: BacktestResult): number {
  const startDate = config.candles.length > 0 ? config.candles[0].time : '';
  const endDate = config.candles.length > 0 ? config.candles[config.candles.length - 1].time : '';

  const { lastId } = execute(
    `INSERT INTO backtest_results
     (name, ticker, market, start_date, end_date, strategy_config_json,
      total_trades, winning_trades, losing_trades, total_return, max_drawdown,
      sharpe_ratio, win_rate, avg_win, avg_loss, profit_factor, results_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [config.name, config.ticker || null, config.market || null,
     startDate, endDate, JSON.stringify(config.weights || {}),
     result.totalTrades, result.winningTrades, result.losingTrades,
     result.totalReturn, result.maxDrawdown, result.sharpeRatio,
     result.winRate, result.avgWin, result.avgLoss, result.profitFactor,
     JSON.stringify(result.trades.slice(0, 100))]
  );

  return lastId;
}

function emptyResult(): BacktestResult {
  return {
    trades: [], totalReturn: 0, maxDrawdown: 0, winRate: 0,
    sharpeRatio: null, avgWin: 0, avgLoss: 0, profitFactor: null,
    totalTrades: 0, winningTrades: 0, losingTrades: 0,
  };
}

// ─── A/B 전략 비교 백테스트 ─────────────────────────────

export interface ABCompareResult {
  strategyA: { name: string; result: BacktestResult };
  strategyB: { name: string; result: BacktestResult };
  winner: 'A' | 'B' | 'TIE';
  comparison: {
    returnDiff: number;       // 수익률 차이 (A - B)
    winRateDiff: number;      // 승률 차이
    drawdownDiff: number;     // 최대낙폭 차이
    sharpeDiff: number | null; // 샤프비율 차이
  };
  summary: string;
}

/**
 * 두 전략을 동일 데이터로 백테스트하여 비교
 * @param candles 동일 캔들 데이터
 * @param weightsA 전략 A 가중치
 * @param weightsB 전략 B 가중치
 */
export function runABCompare(
  candles: CandleData[],
  ticker: string,
  weightsA: Record<ScoreType, number>,
  weightsB: Record<ScoreType, number>,
  nameA: string = '현재 전략',
  nameB: string = '대안 전략',
): ABCompareResult {
  const configBase = { ticker, candles, initialCapital: 2000000 };

  const resultA = runBacktest({ ...configBase, name: nameA, weights: weightsA });
  const resultB = runBacktest({ ...configBase, name: nameB, weights: weightsB });

  const returnDiff = resultA.totalReturn - resultB.totalReturn;
  const winRateDiff = resultA.winRate - resultB.winRate;
  const drawdownDiff = resultA.maxDrawdown - resultB.maxDrawdown;
  const sharpeDiff = (resultA.sharpeRatio !== null && resultB.sharpeRatio !== null)
    ? resultA.sharpeRatio - resultB.sharpeRatio : null;

  // 종합 점수: 수익률 50% + 승률 30% + 낙폭 20%
  const scoreA = resultA.totalReturn * 0.5 + resultA.winRate * 30 - resultA.maxDrawdown * 0.2;
  const scoreB = resultB.totalReturn * 0.5 + resultB.winRate * 30 - resultB.maxDrawdown * 0.2;
  const winner = Math.abs(scoreA - scoreB) < 0.5 ? 'TIE' : scoreA > scoreB ? 'A' : 'B';

  const summary = `${nameA}: 수익 ${resultA.totalReturn.toFixed(1)}%, 승률 ${(resultA.winRate * 100).toFixed(0)}%, 낙폭 ${resultA.maxDrawdown.toFixed(1)}%\n` +
    `${nameB}: 수익 ${resultB.totalReturn.toFixed(1)}%, 승률 ${(resultB.winRate * 100).toFixed(0)}%, 낙폭 ${resultB.maxDrawdown.toFixed(1)}%\n` +
    `승자: ${winner === 'TIE' ? '무승부' : winner === 'A' ? nameA : nameB}`;

  return {
    strategyA: { name: nameA, result: resultA },
    strategyB: { name: nameB, result: resultB },
    winner,
    comparison: { returnDiff, winRateDiff, drawdownDiff, sharpeDiff },
    summary,
  };
}
