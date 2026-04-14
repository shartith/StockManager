/**
 * Market 코드 정규화 — DB에 저장되는 stocks.market 값의 일관성 보장.
 *
 * 문제 배경: 사용자/스케줄러/API가 다양한 시장 표기를 사용
 *   - KIS API는 'NAS', 'NYS', 'AMS' 사용
 *   - Yahoo는 'NASDAQ', 'NYSE' 사용
 *   - 일부 추천 코드는 'NASD' 사용
 *   - scheduler/continuousMonitor.ts는 ['NYSE','NASDAQ','NASD','AMEX']로 매칭
 *
 * 표준화: 'KRX' / 'NYSE' / 'NASDAQ' / 'AMEX' 4종으로 통일.
 * 이외는 'NYSE'로 매핑 (해외 매매 가능한 디폴트).
 */

export type NormalizedMarket = 'KRX' | 'NYSE' | 'NASDAQ' | 'AMEX' | '';

const ALIAS_MAP: Record<string, NormalizedMarket> = {
  // KRX
  'KRX': 'KRX',
  'KOSPI': 'KRX',
  'KOSDAQ': 'KRX',
  // NYSE
  'NYSE': 'NYSE',
  'NYS': 'NYSE',
  'NEW YORK': 'NYSE',
  // NASDAQ
  'NASDAQ': 'NASDAQ',
  'NASD': 'NASDAQ',
  'NAS': 'NASDAQ',
  // AMEX
  'AMEX': 'AMEX',
  'AMS': 'AMEX',
  'NYSE AMEX': 'AMEX',
};

/**
 * 시장 코드를 표준 형태로 정규화한다.
 * 빈 문자열/undefined/null은 그대로 빈 문자열 반환 (KRX 가정 호출처와의 호환).
 */
export function normalizeMarket(input: string | null | undefined): NormalizedMarket {
  if (!input) return '';
  const upper = String(input).trim().toUpperCase();
  return ALIAS_MAP[upper] ?? (upper as NormalizedMarket);
}

/**
 * 해외 시장 여부 (KRX 외 + 빈 값 아님).
 */
export function isOverseasMarket(market: string | null | undefined): boolean {
  const n = normalizeMarket(market);
  return n !== '' && n !== 'KRX';
}
