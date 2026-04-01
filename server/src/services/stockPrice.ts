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
    const data: any = await response.json();
    if (data.rt_cd !== '0') return null;
    const price = Number(data.output?.stck_prpr);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** KIS API로 해외 단일 종목 현재가 조회 */
async function getKisOverseasPrice(ticker: string, token: string, exchCode: string): Promise<number | null> {
  const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
  const trId = isVirtual ? 'VHHDFS76200200' : 'HHDFS76200200';
  try {
    const params = new URLSearchParams({
      AUTH: '', EXCD: exchCode, SYMB: ticker,
    });
    const response = await fetch(
      `${baseUrl}/uapi/overseas-price/v1/quotations/price-detail?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      }
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return null;
    const price = Number(data.output?.last);
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
    const data: any = await response.json();
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

export async function getMultipleStockPrices(tickers: string[], tickerMarkets?: Map<string, string>): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const settings = getSettings();
  const overseasMarkets = ['NASDAQ', 'NYSE', 'AMEX', 'NASD'];

  // 국내/해외 티커 분리
  const domesticTickers: string[] = [];
  const overseasTickers: string[] = [];

  for (const ticker of tickers) {
    const market = tickerMarkets?.get(ticker) || '';
    if (overseasMarkets.includes(market)) {
      overseasTickers.push(ticker);
    } else {
      domesticTickers.push(ticker);
    }
  }

  // 국내 종목: KIS API 우선, 실패 시 Yahoo fallback
  if (domesticTickers.length > 0 && settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      for (const ticker of domesticTickers) {
        const price = await getKisStockPrice(ticker, token);
        if (price !== null) prices.set(ticker, price);
        await new Promise(r => setTimeout(r, 50));
      }
    } catch {
      // KIS 전체 실패 시 Yahoo fallback
      await Promise.allSettled(
        domesticTickers.map(async ticker => {
          const price = await getYahooStockPrice(ticker);
          if (price !== null) prices.set(ticker, price);
        })
      );
    }
  } else if (domesticTickers.length > 0) {
    await Promise.allSettled(
      domesticTickers.map(async ticker => {
        const price = await getYahooStockPrice(ticker);
        if (price !== null) prices.set(ticker, price);
      })
    );
  }

  // 해외 종목: KIS API 우선, 실패 시 Yahoo fallback
  if (overseasTickers.length > 0) {
    const marketToExch: Record<string, string> = { NASDAQ: 'NAS', NYSE: 'NYS', NASD: 'NAS', AMEX: 'AMS' };

    if (settings.kisAppKey && settings.kisAppSecret) {
      try {
        const token = await getAccessToken();
        for (const ticker of overseasTickers) {
          const market = tickerMarkets?.get(ticker) || '';
          const exchCode = marketToExch[market] || 'NAS';
          const price = await getKisOverseasPrice(ticker, token, exchCode);
          if (price !== null) prices.set(ticker, price);
          await new Promise(r => setTimeout(r, 50));
        }
      } catch {
        // KIS 실패 시 Yahoo fallback
      }
    }

    // KIS에서 못 가져온 종목은 Yahoo fallback
    const missingOverseas = overseasTickers.filter(t => !prices.has(t));
    if (missingOverseas.length > 0) {
      await Promise.allSettled(
        missingOverseas.map(async ticker => {
          const price = await getYahooStockPrice(ticker);
          if (price !== null) prices.set(ticker, price);
        })
      );
    }
  }

  return prices;
}
