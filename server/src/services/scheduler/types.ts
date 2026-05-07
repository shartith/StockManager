/**
 * 스케줄러 공유 타입 및 상태
 */

import cron from 'node-cron';
import logger from '../../logger';

type CronTask = ReturnType<typeof cron.schedule>;

export type SchedulePhase = 'PRE_OPEN' | 'POST_OPEN' | 'PRE_CLOSE_1H' | 'PRE_CLOSE_30M' | 'MARKET_OPEN' | 'INTRADAY' | 'PROFIT_TAKING';
export type Market = 'KRX';

export interface ScheduleLog {
  market: Market;
  phase: SchedulePhase;
  timestamp: string;
  status: 'started' | 'completed' | 'error';
  message: string;
}

/** 일일 결정 카운터 — 대시보드 "오늘의 신호". */
export interface DailyDecisions {
  date: string; // 'YYYY-MM-DD' (KST)
  buy: number;  // 실제 체결된 자동 매수 건수
  sell: number; // 실제 체결된 자동 매도 건수 (예약 체결 포함)
  hold: number; // 평가 후 행동 안 한 건수 (게이트 미통과·룰 미발동)
}

const MAX_LOGS = 100;

function todayKstDate(): string {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 스케줄러 공유 상태 */
export const schedulerState = {
  activeTasks: [] as CronTask[],
  recentLogs: [] as ScheduleLog[],
  priceCache: new Map<string, number>(),
  dailyDecisions: { date: todayKstDate(), buy: 0, sell: 0, hold: 0 } as DailyDecisions,
};

/** 로그 추가 헬퍼 */
export function addLog(market: Market, phase: SchedulePhase, status: ScheduleLog['status'], message: string) {
  schedulerState.recentLogs.unshift({
    market,
    phase,
    timestamp: new Date().toISOString(),
    status,
    message,
  });
  if (schedulerState.recentLogs.length > MAX_LOGS) schedulerState.recentLogs.length = MAX_LOGS;
  logger.info(`[Scheduler] [${market}] [${phase}] ${status}: ${message}`);
}

/** 일일 결정 카운터 증가. 날짜 바뀌면 자동 reset. */
export function bumpDecisions(delta: { buy?: number; sell?: number; hold?: number }) {
  const today = todayKstDate();
  if (schedulerState.dailyDecisions.date !== today) {
    schedulerState.dailyDecisions = { date: today, buy: 0, sell: 0, hold: 0 };
  }
  schedulerState.dailyDecisions.buy  += delta.buy  ?? 0;
  schedulerState.dailyDecisions.sell += delta.sell ?? 0;
  schedulerState.dailyDecisions.hold += delta.hold ?? 0;
}

/** 카운터 조회 (자정 reset 적용된 최신 값). */
export function getDecisions(): DailyDecisions {
  const today = todayKstDate();
  if (schedulerState.dailyDecisions.date !== today) {
    schedulerState.dailyDecisions = { date: today, buy: 0, sell: 0, hold: 0 };
  }
  return { ...schedulerState.dailyDecisions };
}
