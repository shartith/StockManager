/**
 * v5.6.1 스케줄러 — Top 10 추종 전략 전용 (라이트 모드).
 *
 *  09:05 평일       : Top 10 rebalance 1차 (시초가 단일가 종료 후 호가 안정 시점)
 *  0 10-14 평일     : Top 10 rebalance 매시간
 *  25 15 평일       : EOD 미체결 force-market (동시호가 합류 → 15:30 마감 체결 보장)
 *  50 15 평일       : EOD KIS balance reconcile
 *
 * v5.6.1 변경:
 *   - 09:00 → 09:05 (시초가 단일가 결정 직후 회피, 호가 안정)
 *   - 한국 공휴일 체크 추가 (KIS 거부 회피)
 *
 * Legacy 12-Rule 매매 엔진 제거 (v5.6.0):
 *   dailyStrategy / autoListBuilder / preMarketStrategy / marketContextMonitor /
 *   holdingsNewsAlert / sellRules / intradayState / reservedOrders / watchTargets
 */

import cron from 'node-cron';
import logger from '../../logger';
import { ScheduleLog, schedulerState, addLog, bumpDecisions, getDecisions } from './types';
import { getSettings } from '../settings';
import { syncKisBalance } from '../balanceSync';
import { chaseStaleOrders } from '../orderChase';
import { runTop10Rebalance } from '../top10Strategy';
import { refreshTop10 } from '../topMarketCap';
import { isKrxHoliday } from '../marketCalendar';

export type { SchedulePhase, Market, ScheduleLog } from './types';

export function getSchedulerLogs(): ScheduleLog[] {
  return schedulerState.recentLogs;
}

export function startScheduler() {
  stopScheduler();
  const settings = getSettings();
  const tz = 'Asia/Seoul';

  if (!settings.scheduleKrx?.enabled) {
    logger.warn(
      '[Scheduler] scheduleKrx.enabled=false — Top10 cron 미등록. 설정에서 활성화하세요.',
    );
    logger.info(`[Scheduler] 총 ${schedulerState.activeTasks.length}개 cron 활성화`);
    return;
  }

  // 공통 휴장일 가드 래퍼
  const guard = (label: string, fn: () => Promise<void>) => async () => {
    if (isKrxHoliday()) {
      logger.info({ label }, '[Scheduler] KRX 휴장일 — cron skip');
      return;
    }
    try { await fn(); } catch (err) {
      logger.error({ err, label }, '[Scheduler] cron failed');
    }
  };

  // 09:05 — 시초가 단일가 종료 후 호가 안정 시점에 1차 rebalance
  // (09:00 정각은 단일가 결정 직후로 호가 단위 불안정 → APBK0506 거부 위험)
  schedulerState.activeTasks.push(
    cron.schedule('5 9 * * 1-5', guard('09:05 rebalance', async () => {
      const r = await runTop10Rebalance('09:05 daily');
      bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
      if (!r.noop) {
        addLog('KRX', 'INTRADAY', 'completed',
          `[Top10] 09:05 — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`);
      }
      logger.info(
        { sold: r.sold.length, bought: r.bought.length, skipped: r.skipped.length, brake: r.brakeReason },
        '[Scheduler] 09:05 Top10 rebalance',
      );
    }), { timezone: tz }),
  );

  // 10:00~14:00 매시간 rebalance
  schedulerState.activeTasks.push(
    cron.schedule('0 10-14 * * 1-5', guard('hourly rebalance', async () => {
      const r = await runTop10Rebalance('hourly');
      bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
      if (!r.noop) {
        addLog('KRX', 'INTRADAY', 'completed',
          `[Top10] hourly — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`);
      }
    }), { timezone: tz }),
  );

  // 15:25 EOD 미체결 force-market
  schedulerState.activeTasks.push(
    cron.schedule('25 15 * * 1-5', guard('EOD force-market', async () => {
      const r = await chaseStaleOrders(true);
      logger.info(r, '[Scheduler] 15:25 EOD force-market');
    }), { timezone: tz }),
  );

  // 15:50 EOD reconcile
  schedulerState.activeTasks.push(
    cron.schedule('50 15 * * 1-5', guard('EOD reconcile', async () => {
      const sync = await syncKisBalance('EOD 자동 reconcile');
      logger.info(sync, '[Scheduler] 15:50 EOD reconcile');
    }), { timezone: tz }),
  );

  logger.info(
    '[Scheduler] Top10 cron 등록 v5.6.1 (09:05 + 10~14시 매시간, 15:25 force-market, 15:50 reconcile, 휴장일 자동 skip)',
  );

  // 서버 시작 직후 Top 10 prefetch (UI 첫 조회 즉시)
  void refreshTop10().catch((err) =>
    logger.warn({ err }, '[Top10] startup prefetch failed'),
  );

  logger.info(`[Scheduler] 총 ${schedulerState.activeTasks.length}개 cron 활성화`);
}

export function stopScheduler() {
  schedulerState.activeTasks.forEach((t) => t.stop());
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
    dailyDecisions: getDecisions(),
  };
}
