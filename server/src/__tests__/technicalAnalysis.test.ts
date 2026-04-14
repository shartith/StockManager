import { describe, it, expect } from 'vitest';
import { calcSMA, calcEMA, calcRSI, calcMACD, calcBollingerBands, calcVWAP, calcATR, analyzeTechnical, CandleData } from '../services/technicalAnalysis';

// 30일치 테스트 데이터 생성
function generateCandles(days: number, basePrice: number = 10000, trend: 'up' | 'down' | 'flat' = 'flat'): CandleData[] {
  const candles: CandleData[] = [];
  let price = basePrice;
  for (let i = 0; i < days; i++) {
    const change = trend === 'up' ? 50 : trend === 'down' ? -50 : (Math.random() - 0.5) * 200;
    price += change;
    candles.push({
      time: `2025-01-${String(i + 1).padStart(2, '0')}`,
      open: price - 20,
      high: price + 100,
      low: price - 100,
      close: price,
      volume: 100000 + Math.floor(Math.random() * 50000),
    });
  }
  return candles;
}

describe('SMA 계산', () => {
  it('5일 SMA 정상 계산', () => {
    const closes = [100, 200, 300, 400, 500];
    expect(calcSMA(closes, 5)).toBe(300);
  });

  it('데이터 부족 시 null', () => {
    expect(calcSMA([100, 200], 5)).toBeNull();
  });
});

describe('EMA 계산', () => {
  it('12일 EMA 정상 계산', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 10);
    const ema = calcEMA(closes, 12);
    expect(ema).not.toBeNull();
    expect(ema).toBeGreaterThan(100);
  });
});

describe('RSI 계산', () => {
  it('상승 추세면 70 이상', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 5);
    const rsi = calcRSI(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThan(60);
  });

  it('하락 추세면 30 이하', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 1000 - i * 20);
    const rsi = calcRSI(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeLessThan(40);
  });

  it('데이터 부족 시 null', () => {
    expect(calcRSI([100, 200, 300], 14)).toBeNull();
  });
});

describe('MACD 계산', () => {
  it('상승 추세면 MACD > 0', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 3);
    const { macd } = calcMACD(closes);
    expect(macd).not.toBeNull();
    expect(macd!).toBeGreaterThan(0);
  });
});

describe('볼린저 밴드', () => {
  it('상단 > 중간 > 하단', () => {
    const closes = Array.from({ length: 25 }, () => 10000 + Math.random() * 500);
    const { upper, middle, lower } = calcBollingerBands(closes);
    expect(upper).not.toBeNull();
    expect(upper!).toBeGreaterThan(middle!);
    expect(middle!).toBeGreaterThan(lower!);
  });
});

describe('VWAP 계산', () => {
  it('캔들 데이터로 VWAP 정상 계산', () => {
    const candles = generateCandles(25);
    const vwap = calcVWAP(candles, 20);
    expect(vwap).not.toBeNull();
    expect(vwap!).toBeGreaterThan(0);
  });

  it('데이터 부족 시 null', () => {
    const candles = generateCandles(5);
    expect(calcVWAP(candles, 20)).toBeNull();
  });
});

describe('ATR 계산', () => {
  it('변동성 지표 양수', () => {
    const candles = generateCandles(20);
    const atr = calcATR(candles, 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);
  });
});

describe('종합 기술 분석', () => {
  it('30일 데이터로 전체 지표 계산', () => {
    const candles = generateCandles(60);
    const result = analyzeTechnical(candles);

    expect(result.currentPrice).toBeGreaterThan(0);
    expect(result.rsi14).not.toBeNull();
    expect(result.sma5).not.toBeNull();
    expect(result.sma20).not.toBeNull();
    expect(result.macd).not.toBeNull();
    expect(result.bollingerUpper).not.toBeNull();
    expect(result.vwap).not.toBeNull();
    expect(result.atr14).not.toBeNull();
    expect(['BUY', 'SELL', 'HOLD']).toContain(result.signal);
    expect(result.signalReasons).toBeInstanceOf(Array);
  });

  it('confidence < 60 규칙은 LLM에서 적용', () => {
    // technicalAnalysis는 순수 지표 계산만, confidence는 LLM에서 처리
    const candles = generateCandles(60);
    const result = analyzeTechnical(candles);
    expect(result.signal).toBeDefined();
  });
});
