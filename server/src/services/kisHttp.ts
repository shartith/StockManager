/**
 * KIS HTTP 공통 호출 — rate-limit 큐 경유 + 자동 재시도.
 *
 * 배경(운영 장애): inquire-balance / candle / balanceSync 등이 직접 fetch 로
 * KIS 를 호출해 rate-limit 큐(apiQueue)를 우회 → 대시보드 폴링 + 스케줄러 +
 * 동기화가 동시에 겹치며 "원장 초당 거래건수 초과(EGW00201)" + HTTP 500 발생.
 *
 * 이 헬퍼는 모든 KIS REST 호출을:
 *   1) kisApiCall(큐) 로 직렬화(초당 15건/동시 3건 제한 준수)
 *   2) rate-limit 신호(HTTP 429/500/503 또는 본문 rt_cd≠0 + 한도초과 msg_cd) 시
 *      지수 백오프로 자동 재시도
 * 하도록 통일한다.
 */

import { kisApiCall } from './apiQueue';
import logger from '../logger';

// 한도/일시장애 계열 KIS 응답 코드 (본문 msg_cd)
const RATE_LIMIT_MSG_CODES = new Set([
  'EGW00201', // 원장 초당 거래건수 초과
  'EGW00133', // 거래건수 초과(시세)
  'EGW00121', // 일시적 오류 계열
]);

export interface KisJsonResult<T = Record<string, unknown>> {
  ok: boolean;       // 정상 응답(rt_cd==='0' 또는 rt_cd 없음) 여부
  status: number;    // HTTP status
  data: T | null;    // 파싱된 본문
  rateLimited: boolean; // 최종적으로도 rate-limit 으로 실패했는지
}

function isRateLimited(status: number, body: { rt_cd?: string; msg_cd?: string } | null): boolean {
  if (status === 429 || status === 500 || status === 503) return true;
  if (body && body.rt_cd !== undefined && body.rt_cd !== '0' && body.msg_cd && RATE_LIMIT_MSG_CODES.has(body.msg_cd)) {
    return true;
  }
  return false;
}

/**
 * 큐 경유 + 재시도 KIS JSON 호출.
 * @param maxRetries rate-limit 시 추가 재시도 횟수 (총 시도 = maxRetries+1)
 */
export async function kisFetchJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit,
  label: string,
  maxRetries = 3,
): Promise<KisJsonResult<T>> {
  let lastStatus = 0;
  let lastData: T | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await kisApiCall(() => fetch(url, init), `${label}#${attempt}`);
    lastStatus = res.status;
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    lastData = data;

    const limited = isRateLimited(res.status, data as { rt_cd?: string; msg_cd?: string } | null);
    if (!limited) {
      const body = data as { rt_cd?: string } | null;
      const ok = res.ok && (!body || body.rt_cd === undefined || body.rt_cd === '0');
      return { ok, status: res.status, data, rateLimited: false };
    }

    if (attempt < maxRetries) {
      // 지수 백오프 + jitter: 0.4s, 0.8s, 1.6s ...
      const backoff = 400 * 2 ** attempt + Math.floor(Math.random() * 150);
      logger.warn({ label, attempt: attempt + 1, status: res.status, backoff }, 'KIS rate-limited — 재시도');
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  logger.error({ label, status: lastStatus }, 'KIS rate-limit 재시도 모두 실패');
  return { ok: false, status: lastStatus, data: lastData, rateLimited: true };
}
