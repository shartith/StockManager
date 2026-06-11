/**
 * KIS 국내 업종지수 (KOSPI/KOSDAQ) 현재지수 — v6.0.9.
 *
 * 배경(운영 신고): 대시보드 KOSPI 7,731(-4.5%) vs KIS 앱 7,531(-2.58%) —
 * 지수를 Yahoo(^KS11, 지연/세션 1일 뒤처짐) + 30분 캐시로 가져와 **전일 종가와
 * 전일 등락률**을 오늘 것처럼 표시. 더 심각하게는 마켓 브레이크(KOSPI -2% 매수차단)·
 * 죽는장 판정·S3 매도 트리거가 같은 Yahoo 데이터로 동작 → 매매 안전망이 하루 늦음.
 *
 * 수정: KIS 업종 현재지수 TR(FHPUP02100000)로 단일화 — 시세와 같은 원천(KIS),
 * 실시간, 큐 경유. Yahoo 는 KIS 미설정/실패 시 폴백으로만.
 *
 * 업종코드: KOSPI '0001', KOSDAQ '1001' (FID_COND_MRKT_DIV_CODE='U').
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { kisFetchJson } from './kisHttp';
import logger from '../logger';

export interface IndexQuote {
  price: number;          // 현재지수
  changePercent: number;  // 전일 대비 등락률 (%)
}

interface IndexOutputRaw {
  bstp_nmix_prpr?: string;      // 업종 지수 현재가
  bstp_nmix_prdy_ctrt?: string; // 전일 대비율
}

/** KIS 응답 → IndexQuote 파싱. 순수 함수 (단위 테스트 대상). 비정상 값은 null. */
export function parseIndexOutput(output: IndexOutputRaw | undefined | null): IndexQuote | null {
  if (!output) return null;
  const price = Number(output.bstp_nmix_prpr);
  const changePercent = Number(output.bstp_nmix_prdy_ctrt);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    price,
    changePercent: Number.isFinite(changePercent) ? changePercent : 0,
  };
}

const INDEX_CODES = { kospi: '0001', kosdaq: '1001' } as const;
type IndexKey = keyof typeof INDEX_CODES;

const CACHE_TTL = 45_000; // 대시보드 폴링/엔진 호출 흡수 — 실시간성과 호출량 균형
let cache: { data: Partial<Record<IndexKey, IndexQuote>>; at: number } | null = null;

async function fetchOne(
  key: IndexKey,
  token: string,
  appKey: string,
  appSecret: string,
  baseUrl: string,
): Promise<IndexQuote | null> {
  // 공식 샘플 표기(대문자 FID_*) 그대로 사용
  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'U',
    FID_INPUT_ISCD: INDEX_CODES[key],
  });
  const { ok, data } = await kisFetchJson<{ rt_cd?: string; output?: IndexOutputRaw }>(
    `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-price?${params}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: 'FHPUP02100000',
        custtype: 'P',
      },
    },
    `index-${key}`,
    1,
  );
  if (!ok || !data?.output) return null;
  return parseIndexOutput(data.output);
}

/**
 * KOSPI/KOSDAQ 현재지수 조회 (KIS, 45초 캐시). KIS 미설정/실패 항목은 누락 —
 * 호출부가 Yahoo 폴백을 책임진다.
 */
export async function getKisIndices(): Promise<Partial<Record<IndexKey, IndexQuote>>> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;

  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret) return {};

  try {
    const token = await getAccessToken();
    const [kospi, kosdaq] = await Promise.all([
      fetchOne('kospi', token, appKey, appSecret, baseUrl),
      fetchOne('kosdaq', token, appKey, appSecret, baseUrl),
    ]);
    const data: Partial<Record<IndexKey, IndexQuote>> = {};
    if (kospi) data.kospi = kospi;
    if (kosdaq) data.kosdaq = kosdaq;
    if (Object.keys(data).length > 0) {
      cache = { data, at: Date.now() };
    } else {
      logger.warn('[KisIndex] KOSPI/KOSDAQ 지수 응답 없음 — Yahoo 폴백 예상');
    }
    return data;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[KisIndex] 지수 조회 실패');
    return cache?.data ?? {};
  }
}

/** 테스트/수동: 캐시 무효화 */
export function invalidateKisIndexCache(): void {
  cache = null;
}
