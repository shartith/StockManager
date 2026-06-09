/**
 * v5.8 순위 이탈 히스테리시스 — 상태 전이 순수 로직 검증.
 *
 * 핵심: 운영 cron 이 시간당(하루 6회) 돌아도 "거래일" 단위로만 카운트가 올라가,
 * 백테스트(일봉 2일 확인)와 동일한 민감도를 유지하는지 확인.
 */

import { describe, it, expect } from 'vitest';
import { nextOutOfUniverseState, shouldPauseRankExit } from '../services/rebalanceStrategy';

describe('shouldPauseRankExit — v6.0.3 "안 봐도 되는 손해" 방지', () => {
  const MAX = 8; // RANK_EXIT_MAX_LOSS

  it('급락 패닉일(marketStressed)이면 손익 무관 매도 보류', () => {
    expect(shouldPauseRankExit(+20, true, MAX)).toBe(true);  // 수익이어도 패닉일엔 보류
    expect(shouldPauseRankExit(-3, true, MAX)).toBe(true);
  });

  it('큰 손실(-8% 초과)이면 매도 보류 — 손실 확정 회피', () => {
    expect(shouldPauseRankExit(-10.41, false, MAX)).toBe(true); // LG엔솔 실제 케이스
    expect(shouldPauseRankExit(-8.01, false, MAX)).toBe(true);
  });

  it('손실이 바닥(-8%) 이내면 정상적으로 순위이탈 매도 허용(회전)', () => {
    expect(shouldPauseRankExit(-7.99, false, MAX)).toBe(false);
    expect(shouldPauseRankExit(-3, false, MAX)).toBe(false);
    expect(shouldPauseRankExit(0, false, MAX)).toBe(false);
    expect(shouldPauseRankExit(+5, false, MAX)).toBe(false); // 수익 종목은 회전 허용
  });

  it('경계값: 정확히 -8% 손실은 보류 아님(초과만 보류)', () => {
    expect(shouldPauseRankExit(-8, false, MAX)).toBe(false);
  });
});

describe('nextOutOfUniverseState — 히스테리시스 거래일 카운터', () => {
  it('Top 20 안이면 카운트/날짜 0으로 리셋', () => {
    const r = nextOutOfUniverseState({ count: 1, lastOutDate: '2026-06-04' }, false, '2026-06-05');
    expect(r.count).toBe(0);
    expect(r.lastOutDate).toBeNull();
    expect(r.changed).toBe(true);
  });

  it('이미 0이고 안쪽이면 changed=false (불필요한 UPDATE 회피)', () => {
    const r = nextOutOfUniverseState({ count: 0, lastOutDate: null }, false, '2026-06-05');
    expect(r.count).toBe(0);
    expect(r.changed).toBe(false);
  });

  it('Top 20 밖 첫 관측 → 카운트 1, 날짜 기록', () => {
    const r = nextOutOfUniverseState({ count: 0, lastOutDate: null }, true, '2026-06-05');
    expect(r.count).toBe(1);
    expect(r.lastOutDate).toBe('2026-06-05');
    expect(r.changed).toBe(true);
  });

  it('같은 날 두 번째 cron — 카운트 증가 안 함 (하루 1회만)', () => {
    const afterFirst = nextOutOfUniverseState({ count: 0, lastOutDate: null }, true, '2026-06-05');
    const afterSecond = nextOutOfUniverseState(
      { count: afterFirst.count, lastOutDate: afterFirst.lastOutDate },
      true,
      '2026-06-05', // 같은 날
    );
    expect(afterSecond.count).toBe(1); // 여전히 1
    expect(afterSecond.changed).toBe(false);
  });

  it('연속 2거래일 밖 → 카운트 2 (EXIT_CONFIRM_TICKS 도달)', () => {
    const day1 = nextOutOfUniverseState({ count: 0, lastOutDate: null }, true, '2026-06-04');
    const day2 = nextOutOfUniverseState(
      { count: day1.count, lastOutDate: day1.lastOutDate },
      true,
      '2026-06-05', // 다음 거래일
    );
    expect(day2.count).toBe(2);
    expect(day2.changed).toBe(true);
  });

  it('하루 6회 cron 시뮬 — 3거래일에 걸쳐도 카운트는 정확히 3', () => {
    let state = { count: 0, lastOutDate: null as string | null };
    const days = ['2026-06-03', '2026-06-04', '2026-06-05'];
    for (const day of days) {
      // 하루 6번 cron
      for (let i = 0; i < 6; i++) {
        const r = nextOutOfUniverseState(state, true, day);
        state = { count: r.count, lastOutDate: r.lastOutDate };
      }
    }
    expect(state.count).toBe(3); // 18회 호출이지만 3거래일 = 3
  });

  it('중간에 Top 20 복귀하면 리셋 — 노이즈 흔들림 매도 방지', () => {
    let state = { count: 0, lastOutDate: null as string | null };
    // 1일차 밖
    let r = nextOutOfUniverseState(state, true, '2026-06-03');
    state = { count: r.count, lastOutDate: r.lastOutDate };
    expect(state.count).toBe(1);
    // 2일차 복귀 (15→16위 갔다가 14위로 — 노이즈)
    r = nextOutOfUniverseState(state, false, '2026-06-04');
    state = { count: r.count, lastOutDate: r.lastOutDate };
    expect(state.count).toBe(0); // 리셋 → 매도 안 함
    // 3일차 다시 밖 → 1부터 다시 시작
    r = nextOutOfUniverseState(state, true, '2026-06-05');
    expect(r.count).toBe(1); // 2가 아님 — 연속성 깨졌으므로
  });
});
