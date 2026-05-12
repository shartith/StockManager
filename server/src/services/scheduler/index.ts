/**
 * v5.6.0 스케줄러 — Top 10 추종 전략 전용 (라이트 모드).
 *
 *  09:00 평일       : Top 10 rebalance 1차 (이탈 매도 + 신규 진입 + 재분배)
 *  0 10-14 평일     : Top 10 rebalance 매시간 (시총 재산정 후 변동분만)
 *  25 15 평일       : EOD 미체결 force-market (동시호가 합류 → 15:30 마감 체결 보장)
 *  50 15 평일       : EOD KIS balance reconcile
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

  // 09:00 — 장 시작 즉시 1차 rebalance
  schedulerState.activeTasks.push(
    cron.schedule(
      '0 9 * * 1-5',
      async () => {
        try {
          const r = await runTop10Rebalance('09:00 daily');
          bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
          if (!r.noop) {
            addLog(
              'KRX',
              'INTRADAY',
              'completed',
              `[Top10] 09:00 — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`,
            );
          }
          logger.info(
            {
              sold: r.sold.length,
              bought: r.bought.length,
              skipped: r.skipped.length,
              brake: r.brakeReason,
            },
            '[Scheduler] 09:00 Top10 rebalance',
          );
        } catch (err) {
          logger.error({ err }, '[Scheduler] Top10 09:00 rebalance failed');
        }
      },
      { timezone: tz },
    ),
  );

  // 10:00~14:00 — 매시간 시총 재산정 + 변경분 rebalance
  schedulerState.activeTasks.push(
    cron.schedule(
      '0 10-14 * * 1-5',
      async () => {
        try {
          const r = await runTop10Rebalance('hourly');
          bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
          if (!r.noop) {
            addLog(
              'KRX',
              'INTRADAY',
              'completed',
              `[Top10] hourly — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`,
            );
          }
        } catch (err) {
          logger.error({ err }, '[Scheduler] Top10 hourly rebalance failed');
        }
      },
      { timezone: tz },
    ),
  );

  // 15:25 — 미체결 주문 일괄 시장가 강제 (동시호가 합류)
  schedulerState.activeTasks.push(
    cron.schedule(
      '25 15 * * 1-5',
      async () => {
        try {
          const r = await chaseStaleOrders(true);
          logger.info(r, '[Scheduler] 15:25 EOD force-market');
        } catch (err) {
          logger.error({ err }, '[Scheduler] EOD force-market failed');
        }
      },
      { timezone: tz },
    ),
  );

  // 15:50 — EOD KIS 잔고 reconcile
  schedulerState.activeTasks.push(
    cron.schedule(
      '50 15 * * 1-5',
      async () => {
        try {
          const sync = await syncKisBalance('EOD 자동 reconcile');
          logger.info(sync, '[Scheduler] 15:50 EOD reconcile');
        } catch (err) {
          logger.error({ err }, '[Scheduler] EOD reconcile failed');
        }
      },
      { timezone: tz },
    ),
  );

  logger.info(
    '[Scheduler] Top10 cron 등록 (09:00 + 10~14시 매시간 rebalance, 15:25 force-market, 15:50 reconcile)',
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
