/**
 * 신호 정확도 분석기
 * LLM 예측 vs 실제 결과를 비교하여 정확도 통계를 산출하고
 * 프롬프트 진화 및 가중치 최적화에 활용한다.
 */

import { queryAll, queryOne } from '../db';

export interface AccuracyStats {
  totalEvaluated: number;
  overallWinRate: number | null;
  byConfidence: { bracket: string; winRate: number; count: number; avgReturn: number }[];
  byMarket: { market: string; winRate: number; count: number; avgReturn: number }[];
  avgReturn7d: number | null;
  avgReturn14d: number | null;
  avgReturn30d: number | null;
  targetHitRate: number | null;
  stopLossHitRate: number | null;
  bestFactors: { factor: string; winRate: number; count: number }[];
  worstFactors: { factor: string; winRate: number; count: number }[];
}

/** 신호 정확도 분석 */
export function analyzeSignalAccuracy(days = 90): AccuracyStats {
  const evaluated = queryAll(
    `SELECT * FROM signal_performance
     WHERE return_7d IS NOT NULL AND signal_type = 'BUY'
     AND created_at >= datetime('now', '-' || ? || ' days')`,
    [days]
  );

  if (evaluated.length === 0) {
    return {
      totalEvaluated: 0, overallWinRate: null,
      byConfidence: [], byMarket: [],
      avgReturn7d: null, avgReturn14d: null, avgReturn30d: null,
      targetHitRate: null, stopLossHitRate: null,
      bestFactors: [], worstFactors: [],
    };
  }

  // 전체 승률
  const wins = evaluated.filter((e: any) => e.return_7d > 0).length;
  const overallWinRate = Math.round((wins / evaluated.length) * 100);

  // 신뢰도 구간별
  const brackets = [
    { bracket: '60-70', min: 60, max: 70 },
    { bracket: '70-80', min: 70, max: 80 },
    { bracket: '80-90', min: 80, max: 90 },
    { bracket: '90-100', min: 90, max: 101 },
  ];
  const byConfidence = brackets.map(b => {
    const group = evaluated.filter((e: any) => e.signal_confidence >= b.min && e.signal_confidence < b.max);
    const groupWins = group.filter((e: any) => e.return_7d > 0).length;
    const avgReturn = group.length > 0 ? group.reduce((s: number, e: any) => s + e.return_7d, 0) / group.length : 0;
    return {
      bracket: b.bracket,
      winRate: group.length > 0 ? Math.round((groupWins / group.length) * 100) : 0,
      count: group.length,
      avgReturn: Math.round(avgReturn * 100) / 100,
    };
  }).filter(b => b.count > 0);

  // 시장별
  const marketGroups = new Map<string, any[]>();
  for (const e of evaluated) {
    const m = e.market || 'KRX';
    if (!marketGroups.has(m)) marketGroups.set(m, []);
    marketGroups.get(m)!.push(e);
  }
  const byMarket = Array.from(marketGroups.entries()).map(([market, group]) => {
    const groupWins = group.filter(e => e.return_7d > 0).length;
    const avgReturn = group.reduce((s, e) => s + e.return_7d, 0) / group.length;
    return {
      market,
      winRate: Math.round((groupWins / group.length) * 100),
      count: group.length,
      avgReturn: Math.round(avgReturn * 100) / 100,
    };
  });

  // 평균 수익률
  const avg7d = evaluated.reduce((s: number, e: any) => s + (e.return_7d || 0), 0) / evaluated.length;
  const eval14d = evaluated.filter((e: any) => e.return_14d !== null);
  const avg14d = eval14d.length > 0 ? eval14d.reduce((s: number, e: any) => s + e.return_14d, 0) / eval14d.length : null;
  const eval30d = evaluated.filter((e: any) => e.return_30d !== null);
  const avg30d = eval30d.length > 0 ? eval30d.reduce((s: number, e: any) => s + e.return_30d, 0) / eval30d.length : null;

  // 목표가/손절가 적중률
  const withTarget = evaluated.filter((e: any) => e.target_price);
  const targetHits = withTarget.filter((e: any) => e.target_hit === 1).length;
  const withStop = evaluated.filter((e: any) => e.stop_loss_price);
  const stopHits = withStop.filter((e: any) => e.stop_loss_hit === 1).length;

  // 핵심 요인 분석
  const factorStats = analyzeFactors(evaluated);

  return {
    totalEvaluated: evaluated.length,
    overallWinRate,
    byConfidence,
    byMarket,
    avgReturn7d: Math.round(avg7d * 100) / 100,
    avgReturn14d: avg14d !== null ? Math.round(avg14d * 100) / 100 : null,
    avgReturn30d: avg30d !== null ? Math.round(avg30d * 100) / 100 : null,
    targetHitRate: withTarget.length > 0 ? Math.round((targetHits / withTarget.length) * 100) : null,
    stopLossHitRate: withStop.length > 0 ? Math.round((stopHits / withStop.length) * 100) : null,
    bestFactors: factorStats.best,
    worstFactors: factorStats.worst,
  };
}

/** 핵심 요인별 승률 분석 */
function analyzeFactors(evaluated: any[]): { best: any[]; worst: any[] } {
  const factorMap = new Map<string, { wins: number; total: number }>();

  for (const e of evaluated) {
    try {
      const factors: string[] = JSON.parse(e.key_factors_json || '[]');
      for (const f of factors) {
        const normalized = f.trim().slice(0, 50); // 정규화
        if (!normalized) continue;
        if (!factorMap.has(normalized)) factorMap.set(normalized, { wins: 0, total: 0 });
        const stat = factorMap.get(normalized)!;
        stat.total++;
        if (e.return_7d > 0) stat.wins++;
      }
    } catch { /* */ }
  }

  const factorList = Array.from(factorMap.entries())
    .filter(([, stat]) => stat.total >= 3) // 최소 3건 이상
    .map(([factor, stat]) => ({
      factor,
      winRate: Math.round((stat.wins / stat.total) * 100),
      count: stat.total,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  return {
    best: factorList.slice(0, 5),
    worst: factorList.slice(-5).reverse(),
  };
}

/** 스코어 타입별 수익률 상관관계 */
export function getScoreTypeCorrelations(): { scoreType: string; correlation: number; count: number }[] {
  // recommendation_scores와 signal_performance를 ticker/시간 기준으로 연결
  const rows = queryAll(`
    SELECT rs.score_type, rs.score_value,
           sp.return_7d
    FROM recommendation_scores rs
    JOIN signal_performance sp ON rs.ticker = sp.ticker
      AND rs.created_at BETWEEN datetime(sp.created_at, '-1 day') AND datetime(sp.created_at, '+1 day')
    WHERE sp.return_7d IS NOT NULL
    ORDER BY rs.score_type
  `);

  // score_type별 그룹화
  const groups = new Map<string, { values: number[]; returns: number[] }>();
  for (const r of rows) {
    if (!groups.has(r.score_type)) groups.set(r.score_type, { values: [], returns: [] });
    const g = groups.get(r.score_type)!;
    g.values.push(r.score_value);
    g.returns.push(r.return_7d);
  }

  return Array.from(groups.entries())
    .filter(([, g]) => g.values.length >= 10)
    .map(([scoreType, g]) => ({
      scoreType,
      correlation: pearsonCorrelation(g.values, g.returns),
      count: g.values.length,
    }))
    .sort((a, b) => b.correlation - a.correlation);
}

/** Pearson 상관계수 계산 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom === 0) return 0;
  return Math.round((sumXY / denom) * 1000) / 1000;
}

/** LLM 프롬프트에 주입할 정확도 리포트 생성 */
export function buildAccuracyReport(): string | null {
  const stats = analyzeSignalAccuracy(60); // 최근 60일

  if (stats.totalEvaluated < 5) return null; // 데이터 부족

  let report = `[과거 예측 성과 피드백 — 최근 ${stats.totalEvaluated}건 분석 결과]
- 전체 BUY 신호 승률: ${stats.overallWinRate}%
- 7일 평균 수익률: ${stats.avgReturn7d}%`;

  if (stats.avgReturn14d !== null) {
    report += ` | 14일: ${stats.avgReturn14d}%`;
  }
  if (stats.avgReturn30d !== null) {
    report += ` | 30일: ${stats.avgReturn30d}%`;
  }

  if (stats.targetHitRate !== null) {
    report += `\n- 목표가 도달률: ${stats.targetHitRate}%`;
  }
  if (stats.stopLossHitRate !== null) {
    report += ` | 손절가 도달률: ${stats.stopLossHitRate}%`;
  }

  if (stats.byConfidence.length > 0) {
    report += '\n- 신뢰도별 승률: ';
    report += stats.byConfidence.map(b => `${b.bracket}%→${b.winRate}%(${b.count}건)`).join(', ');
  }

  if (stats.bestFactors.length > 0) {
    report += '\n- 신뢰할 수 있는 판단 요인: ' + stats.bestFactors.map(f => `${f.factor}(${f.winRate}%)`).join(', ');
  }
  if (stats.worstFactors.length > 0) {
    report += '\n- 주의해야 할 판단 요인: ' + stats.worstFactors.map(f => `${f.factor}(${f.winRate}%)`).join(', ');
  }

  report += '\n\n위 성과를 참고하여 판단 정확도를 개선하세요. 신뢰할 수 있는 요인에 더 큰 비중을 두세요.';

  return report;
}
