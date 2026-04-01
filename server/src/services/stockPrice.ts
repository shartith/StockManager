import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';

/** KIS API로 단일 종목 현재가 조회 */
async function getKisStockPrice(ticker: string, token: string): Promise<number | null> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  try {
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
    });
    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.rt_cd !== '0') return null;
    const price = Number(data.output?.stck_prpr);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** Yahoo Finance fallback (해외주식용) */
async function getYahooStockPrice(ticker: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`
    );
    if (!response.ok) return null;
    const data = await response.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ?? null;
  } catch {
    return null;
  }
}

export async function getStockPrice(ticker: string): Promise<number | null> {
  const settings = getSettings();
  // KIS API 설정이 있으면 KIS 우선
  if (settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      const price = await getKisStockPrice(ticker, token);
      if (price !== null) return price;
    } catch {
      // KIS 실패 시 Yahoo fallback
    }
  }
  // 해외주식 또는 KIS 미설정: Yahoo Finance (ticker.KS 형식 불필요 — 실패하면 null)
  return getYahooStockPrice(ticker);
}

export async function getMultipleStockPrices(tickers: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const settings = getSettings();

  if (settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      // KIS는 rate limit(초당 20건)이 있어 순차 조회 (종목 수가 적으므로 충분)
      for (const ticker of tickers) {
        const price = await getKisStockPrice(ticker, token);
        if (price !== null) prices.set(ticker, price);
        // 연속 요청 사이 50ms 간격
        await new Promise(r => setTimeout(r, 50));
      }
      return prices;
    } catch {
      // 전체 실패 시 Yahoo fallback
    }
  }

  // Yahoo Finance fallback (병렬)
  await Promise.allSettled(
    tickers.map(async ticker => {
      const price = await getYahooStockPrice(ticker);
      if (price !== null) prices.set(ticker, price);
    })
  );
  return prices;
}
