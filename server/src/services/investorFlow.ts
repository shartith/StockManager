/**
 * 외국인/기관 수급 데이터 조회
 * 네이버 금융에서 투자자별 매매동향을 파싱
 */

import { kisApiCall } from './apiQueue';
import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';

export interface InvestorFlowData {
  foreignNet: number;       // 외국인 순매수(주)
  institutionNet: number;   // 기관 순매수(주)
  individualNet: number;    // 개인 순매수(주)
  foreignConsecutive: number; // 연속 순매수일 (양수=매수, 음수=매도)
}

const flowCache = new Map<string, { data: InvestorFlowData; fetchedAt: number }>();
const FLOW_CACHE_TTL = 30 * 60 * 1000; // 30분

/** 네이버 금융에서 외국인/기관 순매매 조회 (국내 종목용) */
async function fetchNaverInvestorFlow(ticker: string): Promise<InvestorFlowData | null> {
  try {
    const url = `https://finance.naver.com/item/frgn.naver?code=${ticker}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;

    const html = await res.text();

    // 테이블에서 최근 5일 데이터 파싱
    const foreignPattern = /외국인.*?>([\-\+]?[\d,]+)</g;
    const institutionPattern = /기관.*?>([\-\+]?[\d,]+)</g;

    // 간단한 대안: KIS API 활용
    return null;
  } catch {
    return null;
  }
}

/** KIS API로 투자자별 매매동향 조회 */
async function fetchKisInvestorFlow(ticker: string): Promise<InvestorFlowData | null> {
  const settings = getSettings();
  if (!settings.kisAppKey || !settings.kisAppSecret) return null;

  try {
    const { appKey, appSecret, baseUrl, isVirtual } = getKisConfig();
    const token = await getAccessToken();

    return await kisApiCall(async () => {
      const params = new URLSearchParams({
        fid_cond_mrkt_div_code: 'J',
        fid_input_iscd: ticker,
      });

      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-investor?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST01010900',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) return null;
      const data: any = await response.json();
      if (data.rt_cd !== '0') return null;

      const items = data.output || [];
      if (items.length === 0) return null;

      // 최근 데이터 합산 (최근 5일)
      let foreignNet = 0;
      let institutionNet = 0;
      let individualNet = 0;
      let foreignConsecutive = 0;
      let lastForeignDirection = 0;

      for (let i = 0; i < Math.min(items.length, 5); i++) {
        const item = items[i];
        const frgn = Number(item.frgn_ntby_qty || 0); // 외국인 순매수
        const inst = Number(item.orgn_ntby_qty || 0);  // 기관 순매수
        const indv = Number(item.prsn_ntby_qty || 0);  // 개인 순매수

        foreignNet += frgn;
        institutionNet += inst;
        individualNet += indv;

        // 연속 순매수일 계산 (최근부터)
        if (i === 0) {
          lastForeignDirection = frgn > 0 ? 1 : frgn < 0 ? -1 : 0;
          foreignConsecutive = lastForeignDirection;
        } else if (lastForeignDirection !== 0) {
          const dir = frgn > 0 ? 1 : frgn < 0 ? -1 : 0;
          if (dir === lastForeignDirection) {
            foreignConsecutive += lastForeignDirection;
          } else {
            lastForeignDirection = 0; // 연속 끊김
          }
        }
      }

      return { foreignNet, institutionNet, individualNet, foreignConsecutive };
    }, `investor-${ticker}`);
  } catch {
    return null;
  }
}

/** 외국인/기관 수급 조회 (캐시 적용) */
export async function getInvestorFlow(ticker: string, market: string): Promise<InvestorFlowData | null> {
  if (market !== 'KRX') return null; // 국내 종목만

  const cached = flowCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < FLOW_CACHE_TTL) return cached.data;

  const data = await fetchKisInvestorFlow(ticker);
  if (data) {
    flowCache.set(ticker, { data, fetchedAt: Date.now() });
  }
  return data;
}
