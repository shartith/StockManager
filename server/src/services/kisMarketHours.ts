/**
 * 국내 시장 세션 + 거래소 라우팅 판정 — 순수 함수 단일 소스 (v6.1.1).
 *
 * NXT(넥스트레이드) 실제 운영시간 (nextrade.co.kr):
 *   · 프리마켓 08:00~08:50 (NXT, 지정가만)
 *   · 메인    09:00~15:30 (KRX 정규장 + NXT → SOR 최선주문집행)
 *   · 애프터  15:30~20:00 (NXT)
 *   · 08:50~09:00 갭: NXT 프리마켓 종료·KRX 미개장 → 주문은 KRX 시초가 동시호가로.
 *
 * 시세 보정(kisBalance)·주문 라우팅(kisOrder)·스케줄러가 모두 이 모듈을 쓴다.
 * 두 곳에서 시간 판정이 갈리면 "확장시간인데 KRX 로 주문 → 거부" 같은 버그가 나므로
 * 반드시 한 곳에서만 정의한다.
 */

export type MarketSession = 'pre' | 'main' | 'after' | 'closed';

const MIN = (h: number, m = 0) => h * 60 + m;

/** KST(UTC+9, DST 없음) 분 단위 시각. 주말이면 -1. */
function kstMinuteOfDay(now: Date): number {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return -1;
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

/**
 * 주문 라우팅용 세션. NXT 실제 체결 가능 시간 기준 — 08:50~09:00 은 NXT 휴장이라 'closed'
 * (이 구간 주문은 resolveExchange 에서 KRX 시초가 동시호가로 라우팅).
 */
export function getKstSession(now: Date): MarketSession {
  const min = kstMinuteOfDay(now);
  if (min < 0) return 'closed';
  if (min >= MIN(8) && min < MIN(8, 50)) return 'pre';      // 08:00~08:49 (NXT 프리마켓)
  if (min >= MIN(9) && min < MIN(15, 30)) return 'main';    // 09:00~15:29 (KRX+NXT)
  if (min >= MIN(15, 30) && min < MIN(20)) return 'after';  // 15:30~19:59 (NXT 애프터)
  return 'closed';
}

/**
 * 화면 시세 보정이 필요한 구간 — inquire-balance(KRX) 가 멈춰 있고 가격이 움직이는 시간.
 * 라우팅 세션과 달리 08:50~09:00(KRX 시초가 동시호가, 예상체결가 변동)도 포함한다.
 * 평일 08:00~09:00, 15:30~20:00.
 */
export function needsUnifiedPrice(now: Date): boolean {
  const min = kstMinuteOfDay(now);
  if (min < 0) return false;
  return (min >= MIN(8) && min < MIN(9)) || (min >= MIN(15, 30) && min < MIN(20));
}

/** 확장 세션(프리/애프터마켓) 여부 — inquire-balance 가 멈춰 통합가 보정이 필요한 구간. */
export function isExtendedSession(session: MarketSession): boolean {
  return session === 'pre' || session === 'after';
}

export type Exchange = 'KRX' | 'NXT' | 'SOR';

/**
 * 주문 거래소 라우팅 결정 — KIS order-cash 의 EXCG_ID_DVSN_CD.
 *   · nxt 비활성 → 'KRX' (현행, 검증된 경로)
 *   · 메인장      → 'SOR' (KRX/NXT 중 유리한 쪽 최선집행)
 *   · 프리/애프터 → 'NXT' (KRX 휴장 — NXT 로만 체결 가능)
 *   · 휴장        → 'KRX' (어차피 주문 안 나감)
 */
export function resolveExchange(session: MarketSession, nxtEnabled: boolean): Exchange {
  if (!nxtEnabled) return 'KRX';
  if (session === 'main') return 'SOR';
  if (session === 'pre' || session === 'after') return 'NXT';
  return 'KRX';
}

/** 시세 조회용 시장구분(FID_COND_MRKT_DIV_CODE): 확장 세션엔 KRX+NXT 통합('UN'), 그 외 KRX('J'). */
export function priceMarketDiv(session: MarketSession): 'UN' | 'J' {
  return isExtendedSession(session) ? 'UN' : 'J';
}
