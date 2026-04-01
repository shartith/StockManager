/** USD/KRW 환율 조회 서비스 */

let cachedRate: { rate: number; fetchedAt: number } | null = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30분 캐시

/** Yahoo Finance에서 USD/KRW 환율 조회 */
async function fetchUsdKrwRate(): Promise<number | null> {
  try {
    const response = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=1d'
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return rate && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/** USD → KRW 환율 반환 (캐시 적용, 실패 시 기본값 1370) */
export async function getUsdKrwRate(): Promise<number> {
  const now = Date.now();
  if (cachedRate && now - cachedRate.fetchedAt < CACHE_DURATION) {
    return cachedRate.rate;
  }

  const rate = await fetchUsdKrwRate();
  if (rate) {
    cachedRate = { rate, fetchedAt: now };
    return rate;
  }

  // 캐시가 만료됐지만 API 실패 시 이전 캐시 사용
  if (cachedRate) return cachedRate.rate;

  // 완전 실패 시 기본값
  return 1370;
}

/** USD 금액을 KRW로 환산 */
export async function convertUsdToKrw(usdAmount: number): Promise<number> {
  const rate = await getUsdKrwRate();
  return Math.round(usdAmount * rate);
}
