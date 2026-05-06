/**
 * v5.1.0 스케줄러 — 강화된 12-Rule 매매.
 *
 *  08:50          : 자동목록 빌드 + daily state reset
 *  *\/5 9-14 *      : 5분 모니터링 (매수창 09:05~09:55, 그 외엔 매도/예약 only)
 *  0 15 * * 1-5    : Rule 10 — +3% 이상 보유분 익절 (EOD profit take)
 *  20 15 * * 1-5   : Rule 11 — 당일 매수분 강제 정리 (동시호가 직전)
 *  50 15 * * 1-5   : EOD KIS balance reconcile + 일일 리포트
 *  *\/30 * * * *    : 예약 주문 만료 정리
 */

import cron from 'node-cron';
import logger from '../../logger';
import { ScheduleLog, schedulerState } from './types';
import { getSettings } from '../settings';
import {
  resetDailyState,
  runFiveMinTick,
  runEodProfitTake,
  runEodForceClose,
  runEodReport,
  runExpiry,
} from '../dailyStrategy';
import { buildAutoList } from '../autoListBuilder';
import { syncKisBalance } from '../balanceSync';
import { runNasSync } from '../nasSync';
import { runNasImport } from '../nasImport';

export type { SchedulePhase, Market, ScheduleLog } from './types';

export function getSchedulerLogs(): ScheduleLog[] {
  return schedulerState.recentLogs;
}

export function startScheduler() {
  stopScheduler();
  const settings = getSettings();
  const tz = 'Asia/Seoul';

  if (settings.scheduleKrx?.enabled) {
    // 08:50 — 자동목록 빌드 (장 시작 10분 전, daily state reset)
    schedulerState.activeTasks.push(cron.schedule('50 8 * * 1-5', async () => {
      try {
        resetDailyState();
        const result = await buildAutoList();
        logger.info(result, '[Scheduler] 08:50 자동목록 빌드');
      } catch (err) {
        logger.error({ err }, '[Scheduler] 08:50 buildAutoList 실패');
      }
    }, { timezone: tz }));

    // 09:00~14:55 — 5분 간격 monitoring (매수창은 09:05~09:55만 dailyStrategy 내부에서 게이팅)
    schedulerState.activeTasks.push(cron.schedule('*/5 9-14 * * 1-5', async () => {
      try {
        const r = await runFiveMinTick();
        if (r.bought + r.sold + r.reservedExecuted > 0 || r.brakeReason) {
          logger.info(r, '[Scheduler] 5min tick');
        }
      } catch (err) {
        logger.error({ err }, '[Scheduler] runFiveMinTick failed');
      }
    }, { timezone: tz }));

    // 15:00 — Rule 10 EOD profit take
    schedulerState.activeTasks.push(cron.schedule('0 15 * * 1-5', async () => {
      try {
        const r = await runEodProfitTake();
        logger.info(r, '[Scheduler] 15:00 EOD profit take');
      } catch (err) {
        logger.error({ err }, '[Scheduler] runEodProfitTake failed');
      }
    }, { timezone: tz }));

    // 15:20 — Rule 11 당일 매수분 강제 정리 (동시호가 직전)
    schedulerState.activeTasks.push(cron.schedule('20 15 * * 1-5', async () => {
      try {
        const r = await runEodForceClose();
        logger.info(r, '[Scheduler] 15:20 EOD force close');
      } catch (err) {
        logger.error({ err }, '[Scheduler] runEodForceClose failed');
      }
    }, { timezone: tz }));

    // 15:50 — EOD reconcile + 일일 리포트
    schedulerState.activeTasks.push(cron.schedule('50 15 * * 1-5', async () => {
      try {
        const sync = await syncKisBalance('EOD 자동 reconcile');
        logger.info(sync, '[Scheduler] 15:50 EOD reconcile');
      } catch (err) {
        logger.error({ err }, '[Scheduler] EOD reconcile failed');
      }
      try {
        const report = await runEodReport();
        logger.info({ summary: report.summary }, '[Scheduler] 15:50 EOD report');
      } catch (err) {
        logger.error({ err }, '[Scheduler] runEodReport failed');
      }
    }, { timezone: tz }));

    logger.info('[Scheduler] KRX 매매 스케줄 등록 (08:50, 5분 모니터, 15:00 익절, 15:20 EOD 정리, 15:50 reconcile)');
  }

  // 예약 주문 만료 정리 (30분마다)
  schedulerState.activeTasks.push(cron.schedule('*/30 * * * *', () => {
    try {
      const r = runExpiry();
      if (r.reservedExpired > 0) logger.info(r, '[Scheduler] expiry');
    } catch (err) {
      logger.error({ err }, '[Scheduler] runExpiry failed');
    }
  }, { timezone: tz }));

  // NAS 동기화 (선택)
  if (settings.nasSyncEnabled && settings.nasSyncPath) {
    const syncTime = settings.nasSyncTime || '0 20 * * *';
    schedulerState.activeTasks.push(cron.schedule(syncTime, async () => {
      try { await runNasSync(); } catch (err) { logger.error({ err }, 'NAS sync failed'); }
      if ((settings as any).nasImportEnabled) {
        try { await runNasImport(); } catch (err) { logger.error({ err }, 'NAS import failed'); }
      }
    }, { timezone: tz }));
    logger.info(`[Scheduler] NAS 동기화 등록 (${syncTime})`);
  }

  logger.info(`[Scheduler] 총 ${schedulerState.activeTasks.length}개 cron 활성화`);
}

export function stopScheduler() {
  schedulerState.activeTasks.forEach(t => t.stop());
  schedulerState.activeTasks.length = 0;
  logger.info('[Scheduler] 모든 스케줄 중지');
}

export function getSchedulerStatus() {
  const settings = getSettings();
  return {
    active: schedulerState.activeTasks.length > 0,
    taskCount: schedulerState.activeTasks.length,
    krxEnabled: settings.scheduleKrx?.enabled ?? false,
    autoTradeEnabled: settings.autoTradeEnabled,
    recentLogs: schedulerState.recentLogs.slice(0, 20),
  };
}
