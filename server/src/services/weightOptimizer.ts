/**
 * 스코어링 가중치 최적화기
 * 성과 데이터를 기반으로 scoring.ts의 가중치를 자동 조정한다.
 * 주간 단위로 실행 (일요일 06:00 KST)
 */

import fs from 'fs';
import path from 'path';
import { execute } from '../db';
import { getScoreTypeCorrelations } from './signalAnalyzer';
import { ScoreType } from './scoring';
import { createNotification } from './notification';
import logger from '../logger';

const WEIGHTS_PATH = path.join(__dirname, '../../../data/scoring-weights.json');

const DEFAULT_WEIGHTS: Record<ScoreType, number> = {
  CONSECUTIVE_BUY: 1.0,
  HIGH_CONFIDENCE: 1.0,
  VOLUME_SURGE: 1.0,
  RSI_OVERSOLD_BOUNCE: 1.0,
  BOLLINGER_BOUNCE: 1.0,
  MACD_GOLDEN_CROSS: 1.0,
  PRICE_MOMENTUM: 1.0,
  NEWS_POSITIVE: 1.0,
  NEWS_SENTIMENT: 1.0,
  TIME_DECAY: 1.0,
  SPREAD_TIGHT: 1.0,
  BOOK_DEPTH_STRONG: 1.0,
  SPREAD_WIDE: 1.0,
  // v4.14.0: 감점 가중치
  SELL_SIGNAL: 1.0,
  HOLD_SIGNAL: 1.0,
  CONSECUTIVE_HOLD: 1.0,
  CONSECUTIVE_SELL: 1.0,
  LOW_CONFIDENCE: 1.0,
  RANK_DECAY: 1.0,
  // v4.17.0: 백테스트 기반
  BACKTEST_PROFITABLE: 1.0,
  BACKTEST_UNPROFITABLE: 1.0,
};

const MIN_WEIGHT = 0.25;
const MAX_WEIGHT = 2.0;
const MAX_ADJUSTMENT = 0.2; // 1회 최대 20% 조정
const MIN_SAMPLE_SIZE = 30;

/** 현재 가중치 로드 */
export function loadWeights(): Record<ScoreType, number> {
  try {
    if (fs.existsSync(WEIGHTS_PATH)) {
      const raw = fs.readFileSync(WEIGHTS_PATH, 'utf-8');
      return { ...DEFAULT_WEIGHTS, ...JSON.parse(raw) };
    }
  } catch { /* */ }
  return { ...DEFAULT_WEIGHTS };
}

/** 가중치 저장 */
export function saveWeights(weights: Record<ScoreType, number>) {
  const dir = path.dirname(WEIGHTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2), 'utf-8');
}

/** 가중치 최적화 실행.
 *  v4.19.0: 조기 종료 사유를 system_events에 INFO로 기록하여 가시성 확보.
 *  signal_performance 100건+ 축적 전까지는 매주 "샘플 부족" 이벤트가 기록됨. */
export function optimizeWeights(): {
  adjusted: { scoreType: string; oldWeight: number; newWeight: number; correlation: number }[];
  skipped: string;
  totalSamples?: number;
  perTypeCounts?: Record<string, number>;
} {
  const correlations = getScoreTypeCorrelations();
  const currentWeights = loadWeights();
  const adjusted: { scoreType: string; oldWeight: number; newWeight: number; correlation: number }[] = [];

  // 샘플 수 체크
  const totalSamples = correlations.reduce((sum, c) => sum + c.count, 0);
  const perTypeCounts: Record<string, number> = {};
  for (const c of correlations) perTypeCounts[c.scoreType] = c.count;

  if (totalSamples < MIN_SAMPLE_SIZE) {
    const skipped = `샘플 부족 (${totalSamples}/${MIN_SAMPLE_SIZE}건)`;
    // v4.19.0: 가시성 — 왜 최적화가 안 되는지 system_events로 노출
    logEarlyExit(skipped, totalSamples, perTypeCounts);
    return { adjusted: [], skipped, totalSamples, perTypeCounts };
  }

  // 개별 타입 최소 샘플 충족하는 타입이 하나도 없으면 조기 종료
  const eligibleTypes = correlations.filter(c => c.count >= 10);
  if (eligibleTypes.length === 0) {
    const skipped = `개별 타입 최소 샘플(10건) 충족 없음 — 총 ${totalSamples}건`;
    logEarlyExit(skipped, totalSamples, perTypeCounts);
    return { adjusted: [], skipped, totalSamples, perTypeCounts };
  }

  for (const { scoreType, correlation, count } of correlations) {
    if (count < 10) continue; // 개별 타입도 최소 10건

    const key = scoreType as ScoreType;
    if (!(key in currentWeights)) continue;

    const oldWeight = currentWeights[key];
    let adjustment = 0;

    // 양의 상관: 가중치 증가, 음의 상관: 가중치 감소
    if (correlation > 0.1) {
      adjustment = Math.min(correlation * 0.3, MAX_ADJUSTMENT);
    } else if (correlation < -0.1) {
      adjustment = Math.max(correlation * 0.3, -MAX_ADJUSTMENT);
    } else {
      continue; // 상관 미미 → 조정 불필요
    }

    let newWeight = oldWeight * (1 + adjustment);
    newWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, newWeight));
    newWeight = Math.round(newWeight * 100) / 100;

    if (Math.abs(newWeight - oldWeight) < 0.01) continue;

    currentWeights[key] = newWeight;

    // 로그 기록
    execute(
      'INSERT INTO weight_optimization_log (score_type, old_weight, new_weight, reason, correlation, sample_size) VALUES (?, ?, ?, ?, ?, ?)',
      [key, oldWeight, newWeight,
       `상관계수 ${correlation} 기반 ${adjustment > 0 ? '증가' : '감소'}`,
       correlation, count]
    );

    adjusted.push({ scoreType: key, oldWeight, newWeight, correlation });
  }

  if (adjusted.length > 0) {
    saveWeights(currentWeights);

    const summary = adjusted.map(a =>
      `${a.scoreType}: ${a.oldWeight}→${a.newWeight} (r=${a.correlation})`
    ).join(', ');

    createNotification({
      type: 'INFO',
      title: '스코어링 가중치 자동 조정',
      message: `${adjusted.length}개 가중치 조정: ${summary}`,
      actionUrl: '/settings',
    });

    logger.info({ adjustedCount: adjusted.length, summary }, 'WeightOptimizer: weights adjusted');
  }

  return { adjusted, skipped: '' };
}

/** 가중치 초기화 */
export function resetWeights(): Record<ScoreType, number> {
  saveWeights(DEFAULT_WEIGHTS);
  return { ...DEFAULT_WEIGHTS };
}

/** v4.19.0: optimizeWeights 조기 종료 시 system_events에 텔레메트리 기록. */
function logEarlyExit(reason: string, totalSamples: number, perTypeCounts: Record<string, number>): void {
  logger.info({ reason, totalSamples, perTypeCounts }, 'WeightOptimizer: early exit');
  // 동기 호출을 유지하기 위해 dynamic import + fire-and-forget
  import('./systemEvent').then(({ logSystemEvent }) => {
    const detail = `총 샘플 ${totalSamples}건\n타입별: ${JSON.stringify(perTypeCounts)}\n사유: ${reason}`;
    logSystemEvent('INFO', 'WEIGHT_OPTIMIZER_SKIP', `가중치 최적화 skip: ${reason}`, detail).catch(() => {});
  }).catch(() => {});
}
