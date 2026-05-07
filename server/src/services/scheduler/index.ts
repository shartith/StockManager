/**
 * v5.2.0 스케줄러 — 1분 모니터링 + 미체결 주문 chase.
 *
 *  08:50          : 자동목록 빌드 + daily state reset
 *  * 9-14 *        : 1분 모니터링 (매수창 09:05~09:55, 그 외엔 매도/예약/chase)
 *  0 15 * * 1-5    : Rule 10 — +3% 이상 보유분 익절
 *  20 15 * * 1-5   : Rule 11 — 당일 매수분 강제 정리 (동시호가 직전)
 *  25 15 * * 1-5   : 미체결 주문 일괄 시장가 강제
 *  50 15 * * 1-5   : EOD KIS balance reconcile + 일일 리포트
 *  *\/30 * * * *    : 예약 주문 만료 정리
 */

import cron from 'node-cron';
import logger from '../../logger';
import { ScheduleLog, schedulerState } from './types';
import { getSettings } from '../settings';
import {
  resetDailyState,
  runMonitorTick,
  runEodProfitTake,
  runEodForceClose,
  runEodReport,
  runExpiry,
} from '../dailyStrategy';
import { buildAutoList } from '../autoListBuilder';
import { syncKisBalance } from '../balanceSync';
import { chaseStaleOrders } from '../orderChase';
import { listActive } from '../watchTargets';

export type { SchedulePhase, Market, ScheduleLog } from './types';

/**
 * 시작 시점 자가복구: 장중(08:50–15:00 KST 평일)에 스케줄러가 (re)등록될 때
 * 오늘자 자동목록이 비어 있으면 즉시 buildAutoList 실행.
 *
 * 해소 시나리오:
 *  - 08:50 cron 이후 시간대에 컨테이너 부팅
 *  - 사용자가 settings 에서 scheduleKrx 를 ON 으로 막 토글한 직후
 *  - 08:50 cron 이 어떤 이유로든 실패한 뒤
 */
async function runStartupAutoListIfNeeded(): Promise<void> {
  const kstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kstNow.getDay();
  if (day === 0 || day === 6) return; // 주말

  const minutes = kstNow.getHours() * 60 + kstNow.getMinutes();
  const WINDOW_START = 8 * 60 + 50;   // 08:50
  const WINDOW_END = 15 * 60;         // 15:00
  if (minutes < WINDOW_START || minutes >= WINDOW_END) return;

  // 활성 auto 목록이 이미 있으면 (다른 cron / 수동 빌드로) skip
  try {
    if (listActive('auto').length > 0) return;
  } catch (err) {
    logger.warn({ err }, '[Scheduler] startup auto-list check failed; will attempt rebuild');
  }

  try {
    resetDailyState();
    const result = await buildAutoList();
    logger.info(result, '[Scheduler] 시작 시점 자동목록 자가복구');
  } catch (err) {
    logger.error({ err }, '[Scheduler] 시작 시점 buildAutoList 실패');
  }
}

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

    // 09:00~14:59 — 1분 간격 monitoring (매수창은 09:05~09:55만 dailyStrategy 내부에서 게이팅)
    schedulerState.activeTasks.push(cron.schedule('* 9-14 * * 1-5', async () => {
      try {
        const r = await runMonitorTick();
        if (r.bought + r.sold + r.reservedExecuted > 0 || r.brakeReason) {
          logger.info(r, '[Scheduler] 1min tick');
        }
      } catch (err) {
        logger.error({ err }, '[Scheduler] runMonitorTick failed');
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

    // 15:25 — 미체결 주문 일괄 시장가 강제 (동시호가 합류 → 15:30 마감 체결 보장)
    schedulerState.activeTasks.push(cron.schedule('25 15 * * 1-5', async () => {
      try {
        const r = await chaseStaleOrders(true);
        logger.info(r, '[Scheduler] 15:25 EOD force-market');
      } catch (err) {
        logger.error({ err }, '[Scheduler] EOD force-market failed');
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

    logger.info('[Scheduler] KRX 매매 스케줄 등록 (08:50, 1분 모니터, 15:00 익절, 15:20 EOD 정리, 15:25 force-market, 15:50 reconcile)');

    // 자가복구: 장중에 (re)등록되었는데 오늘 자동목록이 비어 있으면 즉시 빌드
    void runStartupAutoListIfNeeded();
  } else {
    logger.warn('[Scheduler] scheduleKrx.enabled=false — 08:50 자동목록/매매 cron 미등록. 설정에서 활성화하세요.');
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
