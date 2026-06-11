/**
 * v6.0.9 KIS 업종지수 파싱 — 순수 함수 검증.
 *
 * 운영 신고 재현: 대시보드 KOSPI 7,731(-4.5%) vs KIS 앱 7,531.35(-2.58%) —
 * Yahoo 세션 지연이 원인이었고, KIS 응답(bstp_nmix_*)을 정확히 파싱하는지 확인.
 */

import { describe, it, expect } from 'vitest';
import { parseIndexOutput } from '../services/kisIndex';

describe('parseIndexOutput — KIS 업종 현재지수 파싱', () => {
  it('정상 응답 — 신고 당시 실제 KIS 값 재현', () => {
    const r = parseIndexOutput({ bstp_nmix_prpr: '7531.35', bstp_nmix_prdy_ctrt: '-2.58' });
    expect(r).toEqual({ price: 7531.35, changePercent: -2.58 });
  });

  it('상승 등락률도 부호 그대로', () => {
    const r = parseIndexOutput({ bstp_nmix_prpr: '932.65', bstp_nmix_prdy_ctrt: '1.99' });
    expect(r).toEqual({ price: 932.65, changePercent: 1.99 });
  });

  it('output 없음/현재가 0·음수·비숫자 → null (Yahoo 폴백 유도)', () => {
    expect(parseIndexOutput(undefined)).toBeNull();
    expect(parseIndexOutput(null)).toBeNull();
    expect(parseIndexOutput({})).toBeNull();
    expect(parseIndexOutput({ bstp_nmix_prpr: '0', bstp_nmix_prdy_ctrt: '1' })).toBeNull();
    expect(parseIndexOutput({ bstp_nmix_prpr: 'abc', bstp_nmix_prdy_ctrt: '1' })).toBeNull();
  });

  it('등락률만 비정상이면 0 으로 안전 처리 (지수는 표시)', () => {
    const r = parseIndexOutput({ bstp_nmix_prpr: '7531.35', bstp_nmix_prdy_ctrt: '' });
    expect(r).toEqual({ price: 7531.35, changePercent: 0 });
  });
});
