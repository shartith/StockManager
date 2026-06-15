/**
 * 국내 시장 세션 + 거래소 라우팅 판정 — 순수 함수 단일 소스 (v6.1.0).
 *
 * NXT(넥스트레이드) 가능 계좌 지원:
 *   · 프리마켓 08:00~09:00 (NXT)
 *   · 메인    09:00~15:30 (KRX + NXT 동시 → SOR 최선주문집행)
 *   · 애프터  15:30~20:00 (NXT)
 *
 * 시세 보정(kisBalance)·주문 라우팅(kisOrder)·스케줄러가 모두 이 모듈을 쓴다.
 * 두 곳에서 시간 판정이 갈리면 "확장시간인데 KRX 로 주문 → 거부" 같은 버그가 나므로
 * 반드시 한 곳에서만 정의한다.
 */

export type MarketSession = 'pre' | 'main' | 'after' | 'closed';

/** KST(UTC+9, DST 없음) 기준 현재 세션. 주말은 closed. */
export function getKstSession(now: Date): MarketSession {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return 'closed';
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (min >= 8 * 60 && min < 9 * 60) return 'pre';            // 08:00~08:59
  if (min >= 9 * 60 && min < 15 * 60 + 30) return 'main';     // 09:00~15:29
  if (min >= 15 * 60 + 30 && min < 20 * 60) return 'after';   // 15:30~19:59
  return 'closed';
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
