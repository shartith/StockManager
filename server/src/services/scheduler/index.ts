/**
 * v5.7.0 스케줄러 — 통합 매매 엔진 (트레일링 / 순위이탈 / KOSPI 변동 대응).
 *
 *  매분 09:00-13:59 평일 : Rebalance 1분 간격 (매도 평가 + 매수 평가, 끊김 없음)
 *  매분 14:00-14:29 평일 : Rebalance 1분 간격 (위와 동일, 14:30 스파이크 매도 직전까지)
 *  30 14 평일           : KOSPI +4% 스파이크 매도 (장 마감 전 이익실현 전용)
 *  25 15 평일           : EOD 미체결 force-market (동시호가 합류 → 15:30 마감 체결 보장)
 *  50 15 평일           : EOD KIS balance reconcile
 *
 * v5.7.0 변경:
 *   - top10Strategy → rebalanceStrategy (트레일링 스톱, 순위이탈, KOSPI 신호)
 *   - 14:30 새 cron: KOSPI +4% 상승 시 보유 종목 +5% 이상 수익 매도
 *
 * v6.1.4 변경 — 판단 주기를 09:00~14:29 전체 1분 간격으로 통일:
 *   처음엔 정규장(10~14시) 5분 간격 + 09:00~09:29 전용 1분 간격 "개장 직후 급등감시"
 *   (별도 함수)로 나눠 만들었으나, 1분봉 실측 분석(scripts/analyze-minute-patterns.mjs,
 *   최근 6거래일 Top25 종목 급등일 20건)에서 확인 가능한 급등의 1/3이 두 스케줄
 *   사이 공백이던 09:30~09:59 구간에 몰려 있는 게 드러나 — 09:00~14:29 전체를 예외
 *   없이 1분 간격으로 통일했다(cron 2개로 분리한 건 14:30 스파이크 매도 cron 과 겹치지
 *   않게 하기 위함일 뿐, 로직은 완전히 동일).
 *   - runRebalanceStrategy(rebalanceStrategy.ts)에 재진입 가드 — 1분 간격에서 이전
 *     실행이 안 끝났는데 다음 tick이 겹치는 걸 방지.
 *   - S2 순위이탈 히스테리시스(EXIT_CONFIRM_TICKS)는 거래일 단위 dedup이라 폴링
 *     빈도와 무관 (rebalanceStrategy.ts의 nextOutOfUniverseState 참고).
 *   - B2(미보유 Top10 매수)에 "연속 상승 확인" 급등 버킷 — 시총순위는 유지하되 최근
 *     5분간 꺾이지 않고 오르며 등락률 [3%, 8%]인 종목을 큐 앞으로 당겨 현금을 먼저
 *     배정한다(단발 스파이크 상투매수 방지, isSteadyRiser 참고).
 *   - 급등 확인 후보인데 현금이 모자라면, 소액 손실(손실 금액 기준, 시총 랭킹 비교)
 *     보유종목을 팔아 재원을 확보하는 기회적 스왑매도 추가(trySwapSellForCash 참고).
 *   - 09:00 정각은 시초가 단일가 결정 직후라 호가가 잠깐 불안정할 수 있음(APBK0506
 *     거부 위험) — 다만 주문 실패는 이미 안전하게 skip 처리되고 다음 분에 재시도되므로
 *     별도 지연 로직 없이 09:00부터 바로 시작한다.
 */

import cron from 'node-cron';
import logger from '../../logger';
import { ScheduleLog, schedulerState, addLog, bumpDecisions, getDecisions } from './types';
import { getSettings } from '../settings';
import { syncKisBalance } from '../balanceSync';
import { chaseStaleOrders } from '../orderChase';
import { runRebalanceStrategy } from '../rebalanceStrategy';
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

  // 09:00~14:29 1분 간격 rebalance — 매도(S1-S3)+매수(B1-B4) 전체 평가를 끊김 없이.
  // v6.1.4: 실측 분석으로 09:30~09:59 공백이 급등 포착의 1/3을 놓치는 걸 확인해
  // 09:00~09:29 전용 감시와 정규 rebalance 를 하나로 통일했다(위 파일 헤더 참고).
  // cron 을 두 개(09~13시, 14:00~14:29)로 나눈 건 14:30 스파이크 매도 cron 과 안
  // 겹치게 하기 위함일 뿐 — 핸들러 로직은 완전히 동일하다.
  const rebalanceHandler = guard('1분 간격 rebalance', async () => {
    const r = await runRebalanceStrategy('1분 간격');
    bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
    if (!r.noop) {
      addLog('KRX', 'INTRADAY', 'completed',
        `[Rebal] 1분 간격 — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`);
    }
  });
  schedulerState.activeTasks.push(cron.schedule('* 9-13 * * 1-5', rebalanceHandler, { timezone: tz }));
  schedulerState.activeTasks.push(cron.schedule('0-29 14 * * 1-5', rebalanceHandler, { timezone: tz }));

  // 14:30 — KOSPI +4% 스파이크 시 +5% 이상 수익 종목 매도 (장 마감 전 이익실현)
  // (매수는 안 함 — KOSPI 고점 매수 위험 회피)
  schedulerState.activeTasks.push(
    cron.schedule('30 14 * * 1-5', guard('14:30 KOSPI spike sell', async () => {
      const r = await runRebalanceStrategy('14:30 KOSPI spike', 'kospi-spike-sell-only');
      if (!r.noop) {
        bumpDecisions({ sell: r.sold.length, buy: 0 });
        addLog('KRX', 'INTRADAY', 'completed',
          `[Rebal] 14:30 스파이크 매도 ${r.sold.length}건 (KOSPI ${r.kospiChangePercent}%)`);
      }
      logger.info(
        { sold: r.sold.length, kospi: r.kospiChangePercent },
        '[Scheduler] 14:30 KOSPI spike check',
      );
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

  // ── v6.1 NXT 확장시간 자동매매 (nxtTradingEnabled 일 때만 실제 동작) ──
  // 프리/애프터마켓은 KRX 휴장이라 NXT 로만 체결. 호가가 얇아 지정가(통합가) + 보수적 빈도.
  // 게이트는 cron 안에서 검사 — 설정이 꺼져 있으면 즉시 return (cron 은 항상 등록).
  const nxtGuard = (label: string, fn: () => Promise<void>) => guard(label, async () => {
    if (!getSettings().nxtTradingEnabled) return; // NXT OFF — 확장시간 매매 안 함
    await fn();
  });

  // 08:40 프리마켓 rebalance (08:00 개장 후 호가 안정 시점)
  schedulerState.activeTasks.push(
    cron.schedule('40 8 * * 1-5', nxtGuard('08:40 premarket', async () => {
      const r = await runRebalanceStrategy('08:40 프리마켓(NXT)');
      bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
      if (!r.noop) addLog('KRX', 'PRE_OPEN', 'completed',
        `[Rebal] 프리마켓(NXT) — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`);
      logger.info({ sold: r.sold.length, bought: r.bought.length }, '[Scheduler] 08:40 premarket(NXT)');
    }), { timezone: tz }),
  );

  // 16:00·18:00 애프터마켓 rebalance (15:30~20:00 중 2회 — 얇은 호가 과매매 회피)
  schedulerState.activeTasks.push(
    cron.schedule('0 16,18 * * 1-5', nxtGuard('aftermarket', async () => {
      const r = await runRebalanceStrategy('애프터마켓(NXT)');
      bumpDecisions({ buy: r.bought.length, sell: r.sold.length });
      if (!r.noop) addLog('KRX', 'INTRADAY', 'completed',
        `[Rebal] 애프터마켓(NXT) — 매도 ${r.sold.length}건, 매수 ${r.bought.length}건`);
      logger.info({ sold: r.sold.length, bought: r.bought.length }, '[Scheduler] aftermarket(NXT)');
    }), { timezone: tz }),
  );

  logger.info(
    '[Scheduler] v6.1.4 cron 등록 (09:00-14:29 1분 간격 + 14:30 스파이크, 15:25 force-market, 15:50 reconcile, NXT 08:40/16:00/18:00, 휴장일 skip)',
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
