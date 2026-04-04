/**
 * 자동매매 스케줄러
 * node-cron 기반, 시장별 현지 시간 스케줄링
 * 주말 제외, 연속 모니터링 + 수익 실현 + 추천 갱신 + 공시 감시
 */

import cron from 'node-cron';
import { getSettings } from '../settings';
import { evaluatePendingPerformance } from '../performanceTracker';
import logger from '../../logger';
import { ScheduleLog, schedulerState } from './types';
import { runMarketOpen } from './marketOpen';
import { runContinuousMonitor } from './continuousMonitor';
import { runProfitTaking } from './profitTaking';
import { runRecommendationRefresh } from './recommendations';
import { runWeekendLearning } from './weekendLearning';
import { cleanupWatchlist } from './watchlistCleanup';
import { checkDartDisclosures } from './dartMonitor';
import { runNasSync } from '../nasSync';

// Re-export types for external consumers
export type { SchedulePhase, Market, ScheduleLog } from './types';

// Re-export legacy functions for backward compatibility
export { runPhase, handlePreOpen, handlePostOpen, handlePreClose1h, handlePreClose30m } from './legacy';

// Re-export phase functions
export { runMarketOpen } from './marketOpen';
export { runContinuousMonitor } from './continuousMonitor';
export { runProfitTaking } from './profitTaking';
export { runRecommendationRefresh } from './recommendations';
export { runWeekendLearning } from './weekendLearning';
export { cleanupWatchlist } from './watchlistCleanup';
export { checkDartDisclosures } from './dartMonitor';

/** 스케줄러 로그 조회 */
export function getSchedulerLogs(): ScheduleLog[] {
  return schedulerState.recentLogs;
}

/** 스케줄러 시작 */
export function startScheduler() {
  stopScheduler();
  const settings = getSettings();

  // ── KRX 연속 모니터링 (Asia/Seoul, 월~금) ──
  if (settings.scheduleKrx.enabled) {
    // 장 시작 10분 관망 후: 뉴스 수집 + 갭 분석 + 초기 매수
    schedulerState.activeTasks.push(cron.schedule('10 9 * * 1-5', () => {
      runMarketOpen('KRX').catch(err => logger.error({ err, market: 'KRX' }, 'runMarketOpen failed'));
    }, { timezone: 'Asia/Seoul' }));
    // 장 중: 10분 간격 연속 모니터링 (09:20~14:50)
    schedulerState.activeTasks.push(cron.schedule('*/10 9-14 * * 1-5', () => {
      runContinuousMonitor('KRX').catch(err => logger.error({ err, market: 'KRX' }, 'runContinuousMonitor failed'));
    }, { timezone: 'Asia/Seoul' }));
    // 장 마감 30분 전: 수익 실현 매도
    schedulerState.activeTasks.push(cron.schedule('0 15 * * 1-5', () => {
      runProfitTaking('KRX').catch(err => logger.error({ err, market: 'KRX' }, 'runProfitTaking failed'));
    }, { timezone: 'Asia/Seoul' }));
    logger.info('[Scheduler] KRX 연속 모니터링 등록 (09:10 관망 후 → 10분 간격 → 15:00 수익실현)');
  }

  // ── NYSE/NASDAQ 연속 모니터링 (America/New_York, 월~금) ──
  if (settings.scheduleNyse.enabled) {
    // 장 시작 10분 관망 후: 뉴스 + 갭 분석 + 초기 매수
    schedulerState.activeTasks.push(cron.schedule('40 9 * * 1-5', () => {
      runMarketOpen('NYSE').catch(err => logger.error({ err, market: 'NYSE' }, 'runMarketOpen failed'));
    }, { timezone: 'America/New_York' }));
    // 장 중: 10분 간격 연속 모니터링 (09:50~15:20)
    schedulerState.activeTasks.push(cron.schedule('*/10 9-15 * * 1-5', () => {
      runContinuousMonitor('NYSE').catch(err => logger.error({ err, market: 'NYSE' }, 'runContinuousMonitor failed'));
    }, { timezone: 'America/New_York' }));
    // 장 마감 30분 전: 수익 실현 매도
    schedulerState.activeTasks.push(cron.schedule('30 15 * * 1-5', () => {
      runProfitTaking('NYSE').catch(err => logger.error({ err, market: 'NYSE' }, 'runProfitTaking failed'));
    }, { timezone: 'America/New_York' }));
    logger.info('[Scheduler] NYSE 연속 모니터링 등록 (09:40 관망 후 → 10분 간격 → 15:30 수익실현)');
  }

  // ── 추천종목 자동 갱신 (매 시간) ──
  if (settings.ollamaEnabled) {
    schedulerState.activeTasks.push(cron.schedule('0 * * * *', () => {
      runRecommendationRefresh().catch(err => logger.error({ err }, 'runRecommendationRefresh failed'));
    }, { timezone: 'Asia/Seoul' }));
    logger.info('[Scheduler] 추천종목 자동 갱신 스케줄 등록 (매 1시간)');
  }

  // ── DART 공시 감시 (10분 간격, KRX 장 시간) ──
  if (settings.dartEnabled && settings.dartApiKey) {
    schedulerState.activeTasks.push(cron.schedule('*/10 9-15 * * 1-5', () => {
      checkDartDisclosures().catch(err => logger.error({ err }, 'checkDartDisclosures failed'));
    }, { timezone: 'Asia/Seoul' }));
    logger.info('[Scheduler] DART 공시 감시 스케줄 등록 (10분 간격, 09~15시)');
  }

  // ── 일일 성과 평가 (18:00 KST, 평일) ──
  schedulerState.activeTasks.push(cron.schedule('0 18 * * 1-5', async () => {
    try { await evaluatePendingPerformance(); } catch (err) {
      logger.error({ err }, 'evaluatePendingPerformance failed');
    }
  }, { timezone: 'Asia/Seoul' }));
  logger.info('[Scheduler] 일일 성과 평가 스케줄 등록 (18:00 KST)');

  // ── 관심종목 자동 정리 (22:00 KST, 매일) ──
  schedulerState.activeTasks.push(cron.schedule('0 22 * * *', () => {
    try { cleanupWatchlist(); } catch (err) { logger.error({ err }, 'cleanupWatchlist failed'); }
  }, { timezone: 'Asia/Seoul' }));
  logger.info('[Scheduler] 관심종목 자동 정리 스케줄 등록 (22:00 KST)');

  // ── 주말 학습 (토요일 06:00 KST) ──
  schedulerState.activeTasks.push(cron.schedule('0 6 * * 6', () => {
    runWeekendLearning().catch(err => logger.error({ err }, 'runWeekendLearning failed'));
  }, { timezone: 'Asia/Seoul' }));
  logger.info('[Scheduler] 주말 학습 스케줄 등록 (토요일 06:00 KST)');

  // ── NAS 데이터 동기화 ──
  if (settings.nasSyncEnabled && settings.nasSyncPath) {
    const syncTime = settings.nasSyncTime || '0 20 * * *';
    schedulerState.activeTasks.push(cron.schedule(syncTime, () => {
      runNasSync().catch(err => logger.error({ err }, 'NAS sync failed'));
    }, { timezone: 'Asia/Seoul' }));
    logger.info(`[Scheduler] NAS 동기화 스케줄 등록 (${syncTime})`);
  }

  if (schedulerState.activeTasks.length > 0) {
    logger.info(`[Scheduler] 총 ${schedulerState.activeTasks.length}개 스케줄 활성화`);
  } else {
    logger.info('[Scheduler] 활성화된 스케줄 없음');
  }
}

/** 스케줄러 중지 */
export function stopScheduler() {
  schedulerState.activeTasks.forEach(task => task.stop());
  schedulerState.activeTasks.length = 0;
  logger.info('[Scheduler] 모든 스케줄 중지');
}

/** 스케줄러 상태 */
export function getSchedulerStatus() {
  const settings = getSettings();
  return {
    active: schedulerState.activeTasks.length > 0,
    taskCount: schedulerState.activeTasks.length,
    krxEnabled: settings.scheduleKrx.enabled,
    nyseEnabled: settings.scheduleNyse.enabled,
    autoTradeEnabled: settings.autoTradeEnabled,
    recentLogs: schedulerState.recentLogs.slice(0, 20),
  };
}
