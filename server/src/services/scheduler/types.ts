/**
 * 스케줄러 공유 타입 및 상태
 */

import cron from 'node-cron';
import logger from '../../logger';

type CronTask = ReturnType<typeof cron.schedule>;

export type SchedulePhase = 'PRE_OPEN' | 'POST_OPEN' | 'PRE_CLOSE_1H' | 'PRE_CLOSE_30M' | 'MARKET_OPEN' | 'INTRADAY' | 'PROFIT_TAKING';
export type Market = 'KRX' | 'NYSE' | 'NASDAQ';

export interface ScheduleLog {
  market: Market;
  phase: SchedulePhase;
  timestamp: string;
  status: 'started' | 'completed' | 'error';
  message: string;
}

const MAX_LOGS = 100;

/** 스케줄러 공유 상태 */
export const schedulerState = {
  activeTasks: [] as CronTask[],
  recentLogs: [] as ScheduleLog[],
  priceCache: new Map<string, number>(),
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
