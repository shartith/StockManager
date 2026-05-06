/**
 * Market 코드 정규화 — DB에 저장되는 stocks.market 값의 일관성 보장.
 * KRX 단일 시장만 지원.
 */

export type NormalizedMarket = 'KRX' | '';

const ALIAS_MAP: Record<string, NormalizedMarket> = {
  'KRX': 'KRX',
  'KOSPI': 'KRX',
  'KOSDAQ': 'KRX',
};

/**
 * 시장 코드를 표준 형태로 정규화한다.
 * 빈 문자열/undefined/null은 그대로 빈 문자열 반환.
 */
export function normalizeMarket(input: string | null | undefined): NormalizedMarket {
  if (!input) return '';
  const upper = String(input).trim().toUpperCase();
  return ALIAS_MAP[upper] ?? '';
}
