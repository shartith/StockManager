/**
 * 기술적 분석 지표 계산 서비스
 * RSI, SMA, EMA, MACD, Bollinger Bands
 */

export interface CandleData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  rsi14: number | null;
  sma5: number | null;
  sma20: number | null;
  sma60: number | null;
  sma120: number | null;
  ema12: number | null;
  ema26: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  vwap: number | null;
  atr14: number | null;
  currentPrice: number;
  signal: 'BUY' | 'SELL' | 'HOLD';
  signalReasons: string[];
}

/** SMA (Simple Moving Average) */
export function calcSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** EMA (Exponential Moving Average) */
export function calcEMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/** RSI (Relative Strength Index) */
export function calcRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD (12, 26, 9) */
export function calcMACD(closes: number[]): { macd: number | null; signal: number | null; histogram: number | null } {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);

  if (ema12 === null || ema26 === null) {
    return { macd: null, signal: null, histogram: null };
  }

  // MACD line 시계열 계산 (signal line용)
  const macdLine: number[] = [];
  const k12 = 2 / 13;
  const k26 = 2 / 27;

  let e12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

  for (let i = 12; i < 26; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
  }

  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    macdLine.push(e12 - e26);
  }

  if (macdLine.length < 9) {
    return { macd: macdLine[macdLine.length - 1] ?? null, signal: null, histogram: null };
  }

  // Signal line (MACD의 9일 EMA)
  const k9 = 2 / 10;
  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdLine.length; i++) {
    sig = macdLine[i] * k9 + sig * (1 - k9);
  }

  const macdVal = macdLine[macdLine.length - 1];
  return {
    macd: Math.round(macdVal * 100) / 100,
    signal: Math.round(sig * 100) / 100,
    histogram: Math.round((macdVal - sig) * 100) / 100,
  };
}

/** Bollinger Bands (20일, 2σ) */
export function calcBollingerBands(closes: number[], period: number = 20, stdDev: number = 2): { upper: number | null; middle: number | null; lower: number | null } {
  if (closes.length < period) return { upper: null, middle: null, lower: null };

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);

  return {
    upper: Math.round((mean + stdDev * sd) * 100) / 100,
    middle: Math.round(mean * 100) / 100,
    lower: Math.round((mean - stdDev * sd) * 100) / 100,
  };
}

/** VWAP (Volume Weighted Average Price) — 거래량 가중 평균가 */
export function calcVWAP(candles: CandleData[], period: number = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  let sumPV = 0;
  let sumV = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    sumPV += typical * c.volume;
    sumV += c.volume;
  }
  return sumV > 0 ? Math.round((sumPV / sumV) * 100) / 100 : null;
}

/** ATR (Average True Range) — 평균 변동폭 (변동성 지표) */
export function calcATR(candles: CandleData[], period: number = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  // EMA 방식 ATR
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Math.round(atr * 100) / 100;
}

/** 종합 기술적 분석 — 캔들 데이터를 받아 모든 지표 + 매매 신호 반환 */
export function analyzeTechnical(candles: CandleData[]): TechnicalIndicators {
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  const rsi14 = calcRSI(closes, 14);
  const sma5 = calcSMA(closes, 5);
  const sma20 = calcSMA(closes, 20);
  const sma60 = calcSMA(closes, 60);
  const sma120 = calcSMA(closes, 120);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const { macd, signal: macdSignal, histogram: macdHistogram } = calcMACD(closes);
  const { upper: bollingerUpper, middle: bollingerMiddle, lower: bollingerLower } = calcBollingerBands(closes);
  const vwap = calcVWAP(candles, 20);
  const atr14 = calcATR(candles, 14);

  // 매매 신호 판별
  const signalReasons: string[] = [];
  let buyScore = 0;
  let sellScore = 0;

  // RSI 기반
  if (rsi14 !== null) {
    if (rsi14 < 30) { buyScore += 2; signalReasons.push(`RSI 과매도 (${rsi14.toFixed(1)})`); }
    else if (rsi14 < 40) { buyScore += 1; signalReasons.push(`RSI 낮음 (${rsi14.toFixed(1)})`); }
    else if (rsi14 > 70) { sellScore += 2; signalReasons.push(`RSI 과매수 (${rsi14.toFixed(1)})`); }
    else if (rsi14 > 60) { sellScore += 1; signalReasons.push(`RSI 높음 (${rsi14.toFixed(1)})`); }
  }

  // MACD 기반
  if (macd !== null && macdSignal !== null) {
    if (macd > macdSignal && macdHistogram! > 0) {
      buyScore += 1;
      signalReasons.push('MACD 골든크로스');
    } else if (macd < macdSignal && macdHistogram! < 0) {
      sellScore += 1;
      signalReasons.push('MACD 데드크로스');
    }
  }

  // 이동평균 기반
  if (sma5 !== null && sma20 !== null) {
    if (sma5 > sma20 && currentPrice > sma5) {
      buyScore += 1;
      signalReasons.push('단기 이평선 정배열');
    } else if (sma5 < sma20 && currentPrice < sma5) {
      sellScore += 1;
      signalReasons.push('단기 이평선 역배열');
    }
  }

  // 볼린저 밴드 기반
  if (bollingerLower !== null && bollingerUpper !== null) {
    if (currentPrice <= bollingerLower) {
      buyScore += 1;
      signalReasons.push('볼린저 하단 터치');
    } else if (currentPrice >= bollingerUpper) {
      sellScore += 1;
      signalReasons.push('볼린저 상단 터치');
    }
  }

  // VWAP 기반 (현재가 vs 거래량 가중 평균)
  if (vwap !== null) {
    if (currentPrice > vwap * 1.02) {
      sellScore += 1;
      signalReasons.push(`VWAP 상회 (+${((currentPrice / vwap - 1) * 100).toFixed(1)}%)`);
    } else if (currentPrice < vwap * 0.98) {
      buyScore += 1;
      signalReasons.push(`VWAP 하회 (${((currentPrice / vwap - 1) * 100).toFixed(1)}%)`);
    }
  }

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if (buyScore >= 3 && buyScore > sellScore) signal = 'BUY';
  else if (sellScore >= 3 && sellScore > buyScore) signal = 'SELL';

  return {
    rsi14: rsi14 !== null ? Math.round(rsi14 * 100) / 100 : null,
    sma5: sma5 !== null ? Math.round(sma5 * 100) / 100 : null,
    sma20: sma20 !== null ? Math.round(sma20 * 100) / 100 : null,
    sma60: sma60 !== null ? Math.round(sma60 * 100) / 100 : null,
    sma120: sma120 !== null ? Math.round(sma120 * 100) / 100 : null,
    ema12: ema12 !== null ? Math.round(ema12 * 100) / 100 : null,
    ema26: ema26 !== null ? Math.round(ema26 * 100) / 100 : null,
    macd,
    macdSignal,
    macdHistogram,
    bollingerUpper,
    bollingerMiddle,
    bollingerLower,
    vwap,
    atr14,
    currentPrice,
    signal,
    signalReasons,
  };
}
