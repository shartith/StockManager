/**
 * 캔들 패턴 인식 (룰 기반).
 *
 * 5개 강세 + 3개 약세 패턴 검출. 일봉 기준 (KIS 일봉 데이터).
 * 각 패턴 함수는 캔들 배열 끝 부분(가장 최근 N봉)을 검사한다.
 *
 * - 강세: HAMMER, BULLISH_ENGULFING, MORNING_STAR, PIERCING, BULLISH_MARUBOZU
 * - 약세: BEARISH_ENGULFING, EVENING_STAR, BEARISH_MARUBOZU
 *
 * 모든 함수는 sufficient candle history 가 없으면 false 반환 (안전 fallback).
 */

import type { CandleData } from './technicalAnalysis';

export type BullishPattern = 'HAMMER' | 'BULLISH_ENGULFING' | 'MORNING_STAR' | 'PIERCING' | 'BULLISH_MARUBOZU';
export type BearishPattern = 'BEARISH_ENGULFING' | 'EVENING_STAR' | 'BEARISH_MARUBOZU';
export type CandlePattern = BullishPattern | BearishPattern;

export interface PatternMatch {
  pattern: CandlePattern;
  bullish: boolean;
  description: string;
  /** 최근 N봉 평균 거래량 대비 현재 봉 거래량 배수 (확신도 보정용) */
  volumeFactor: number;
}

interface CandleAnatomy {
  body: number;        // |close - open|
  range: number;       // high - low
  upperWick: number;   // high - max(open, close)
  lowerWick: number;   // min(open, close) - low
  isBull: boolean;
  bodyToRange: number; // body / range
}

function anatomy(c: CandleData): CandleAnatomy {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return {
    body,
    range,
    upperWick,
    lowerWick,
    isBull: c.close > c.open,
    bodyToRange: body / range,
  };
}

function avgVolume(candles: CandleData[], period: number): number {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c.volume, 0) / period;
}

function isDownTrend(candles: CandleData[], lookback: number = 5): boolean {
  if (candles.length < lookback + 1) return false;
  const recent = candles.slice(-lookback - 1, -1);
  const firstClose = recent[0].close;
  const lastClose = recent[recent.length - 1].close;
  return lastClose < firstClose * 0.99; // 직전 lookback 일 동안 -1% 이상 하락
}

function isUpTrend(candles: CandleData[], lookback: number = 5): boolean {
  if (candles.length < lookback + 1) return false;
  const recent = candles.slice(-lookback - 1, -1);
  const firstClose = recent[0].close;
  const lastClose = recent[recent.length - 1].close;
  return lastClose > firstClose * 1.01;
}

// ── 강세 패턴 ───────────────────────────────────────────────

/** Hammer — 다운트렌드 끝, 긴 아래꼬리 + 짧은 본체 */
export function detectHammer(candles: CandleData[]): boolean {
  if (candles.length < 6) return false;
  const last = candles[candles.length - 1];
  const a = anatomy(last);
  if (!isDownTrend(candles)) return false;
  return a.lowerWick >= a.body * 2
      && a.upperWick <= a.body * 0.3
      && a.bodyToRange > 0.1
      && a.bodyToRange < 0.4;
}

/** Bullish Engulfing — 음봉 → 양봉, 양봉 본체가 음봉 본체 완전 포함 */
export function detectBullishEngulfing(candles: CandleData[]): boolean {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  if (prev.close >= prev.open) return false; // 직전 음봉 필수
  if (curr.close <= curr.open) return false; // 현재 양봉 필수
  return curr.open <= prev.close && curr.close >= prev.open;
}

/** Morning Star — 큰 음봉 → 작은 캔들(갭다운) → 큰 양봉(50%+ 회복) */
export function detectMorningStar(candles: CandleData[]): boolean {
  if (candles.length < 3) return false;
  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];
  const a1 = anatomy(c1), a2 = anatomy(c2), a3 = anatomy(c3);
  // c1: 큰 음봉
  if (a1.isBull || a1.body / a1.range < 0.5) return false;
  // c2: 작은 캔들 (도지/팽이)
  if (a2.body / a1.body > 0.3) return false;
  // 갭다운: c2 high < c1 close
  if (c2.high >= c1.close) return false;
  // c3: 큰 양봉, c1 50% 이상 회복
  if (!a3.isBull || a3.body / a3.range < 0.5) return false;
  const c1Mid = (c1.open + c1.close) / 2;
  return c3.close >= c1Mid;
}

/** Piercing Line — 음봉 → 양봉 시가 음봉 저점 이하, 종가 음봉 50% 이상 회복 */
export function detectPiercing(candles: CandleData[]): boolean {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  if (prev.close >= prev.open) return false; // 직전 음봉
  if (curr.close <= curr.open) return false; // 현재 양봉
  if (curr.open >= prev.low) return false;   // 시가가 직전 저점 아래로 갭다운
  const prevMid = (prev.open + prev.close) / 2;
  return curr.close >= prevMid && curr.close < prev.open; // 음봉 50% 회복하지만 음봉 시가는 못 넘음
}

/** Bullish Marubozu — 꼬리 거의 없는 강한 양봉 + 거래량 1.5x */
export function detectBullishMarubozu(candles: CandleData[]): boolean {
  if (candles.length < 6) return false;
  const last = candles[candles.length - 1];
  const a = anatomy(last);
  if (!a.isBull) return false;
  if (a.bodyToRange < 0.85) return false;
  if (a.upperWick > a.body * 0.05) return false;
  if (a.lowerWick > a.body * 0.05) return false;
  const avgVol5 = avgVolume(candles.slice(0, -1), 5);
  return avgVol5 > 0 && last.volume >= avgVol5 * 1.5;
}

// ── 약세 패턴 ───────────────────────────────────────────────

/** Bearish Engulfing — 양봉 → 음봉, 음봉 본체가 양봉 본체 완전 포함 */
export function detectBearishEngulfing(candles: CandleData[]): boolean {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  if (prev.close <= prev.open) return false;
  if (curr.close >= curr.open) return false;
  return curr.open >= prev.close && curr.close <= prev.open;
}

/** Evening Star — 큰 양봉 → 작은 캔들(갭업) → 큰 음봉(50%+ 침투) */
export function detectEveningStar(candles: CandleData[]): boolean {
  if (candles.length < 3) return false;
  const c1 = candles[candles.length - 3];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 1];
  const a1 = anatomy(c1), a2 = anatomy(c2), a3 = anatomy(c3);
  if (!a1.isBull || a1.body / a1.range < 0.5) return false;
  if (a2.body / a1.body > 0.3) return false;
  if (c2.low <= c1.close) return false; // 갭업
  if (a3.isBull || a3.body / a3.range < 0.5) return false;
  const c1Mid = (c1.open + c1.close) / 2;
  return c3.close <= c1Mid;
}

/** Bearish Marubozu — 꼬리 거의 없는 강한 음봉 + 거래량 1.5x */
export function detectBearishMarubozu(candles: CandleData[]): boolean {
  if (candles.length < 6) return false;
  const last = candles[candles.length - 1];
  const a = anatomy(last);
  if (a.isBull) return false;
  if (a.bodyToRange < 0.85) return false;
  if (a.upperWick > a.body * 0.05) return false;
  if (a.lowerWick > a.body * 0.05) return false;
  const avgVol5 = avgVolume(candles.slice(0, -1), 5);
  return avgVol5 > 0 && last.volume >= avgVol5 * 1.5;
}

// ── 통합 검출 ───────────────────────────────────────────────

const PATTERN_DETECTORS: Array<[CandlePattern, (cs: CandleData[]) => boolean, boolean, string]> = [
  ['HAMMER',              detectHammer,              true,  '해머 (다운트렌드 반전 신호)'],
  ['BULLISH_ENGULFING',   detectBullishEngulfing,    true,  '강세 잉걸핑 (음→양 본체 포함)'],
  ['MORNING_STAR',        detectMorningStar,         true,  '모닝스타 3봉 (반전)'],
  ['PIERCING',            detectPiercing,            true,  '관통형 (50%+ 회복)'],
  ['BULLISH_MARUBOZU',    detectBullishMarubozu,     true,  '장대양봉 (꼬리 거의 없음, 고거래량)'],
  ['BEARISH_ENGULFING',   detectBearishEngulfing,    false, '약세 잉걸핑 (양→음 본체 포함)'],
  ['EVENING_STAR',        detectEveningStar,         false, '이브닝스타 3봉 (천장 반전)'],
  ['BEARISH_MARUBOZU',    detectBearishMarubozu,     false, '장대음봉 (꼬리 거의 없음, 고거래량)'],
];

/** 모든 패턴 검출 — 일치하는 패턴 배열 반환. 보통 0~2개 (서로 배타적이지 않음). */
export function detectAllPatterns(candles: CandleData[]): PatternMatch[] {
  if (candles.length < 6) return [];
  const last = candles[candles.length - 1];
  const avgVol5 = avgVolume(candles.slice(0, -1), 5);
  const volumeFactor = avgVol5 > 0 ? last.volume / avgVol5 : 1;
  const matches: PatternMatch[] = [];
  for (const [name, fn, bullish, description] of PATTERN_DETECTORS) {
    if (fn(candles)) {
      matches.push({ pattern: name, bullish, description, volumeFactor });
    }
  }
  return matches;
}

export function hasBearishPattern(candles: CandleData[]): { found: boolean; pattern?: CandlePattern; description?: string } {
  const matches = detectAllPatterns(candles);
  const bearish = matches.find(m => !m.bullish);
  if (bearish) return { found: true, pattern: bearish.pattern, description: bearish.description };
  return { found: false };
}

export function hasBullishPattern(candles: CandleData[]): { found: boolean; pattern?: CandlePattern; description?: string } {
  const matches = detectAllPatterns(candles);
  const bullish = matches.find(m => m.bullish);
  if (bullish) return { found: true, pattern: bullish.pattern, description: bullish.description };
  return { found: false };
}
