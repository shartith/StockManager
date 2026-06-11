/**
 * KIS 실계좌 잔고 조회 — 큐 경유 + 짧은 캐시 (단일 소스).
 *
 * 배경(운영 장애): /chart/balance 와 /portfolio/summary 가 각각 잔고를 직접 조회 →
 * KIS 호출 중복 + rate-limit. 또한 대시보드 헤드라인 "현재 평가금액"이 DB 추정치라
 * 실제 증권사 평가금액과 어긋남(예: 시스템 3,743,000 vs KIS 4,211,900).
 *
 * 이 모듈을 단일 소스로:
 *   - inquire-balance 를 kisFetchJson(큐+재시도)로 1회 호출, 5초 캐시
 *   - 헤드라인(평가금액/매입금액/손익)은 증권사 실수치를 사용 → DB 추정과 어긋나지 않음
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { kisFetchJson } from './kisHttp';
import { getDomesticOrderableAmount } from './kisOrder';

export interface KisHolding {
  ticker: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  profitLossRate: number;
  totalValue: number;
}

export interface KisBalance {
  holdings: KisHolding[];
  totalPurchaseAmount: number;
  totalEvalAmount: number;       // 증권사 실제 평가금액 (진실의 원천)
  totalProfitLoss: number;
  totalProfitLossRate: number;
  depositAmount: number;
  orderableAmount: number;
  fetchedAt: string;
  stale?: boolean;
  extendedHours?: boolean;       // v6.0.8: 장전·장후(NXT) 통합 시세 보정 적용 여부
}

let cache: { data: KisBalance; at: number } | null = null;
const CACHE_TTL = 5_000;

/**
 * v6.0.8 확장 거래시간(장전·장후) 판정 — 순수 함수.
 *
 * 배경: inquire-balance 의 prpr/evlu_amt 는 KRX 정규장 기준이라
 *   · 장전(08:00~09:00): NXT 프리마켓 체결/예상체결가가 반영 안 됨 (전일종가 고정)
 *   · 장후(15:30~20:00): NXT 애프터마켓 체결이 반영 안 됨 (KRX 종가 고정)
 * 인데 KIS 앱은 KRX+NXT 통합가로 평가 → 같은 시각인데 화면이 어긋남.
 *
 * 따라서 "거래는 일어나는데 prpr 이 멈춰 있는" 평일 08:00~20:00 중 KRX 정규장
 * (09:00~15:30) 밖 시간대에 종목별 통합 시세로 보정한다.
 * 정규장 중엔 prpr 자체가 실시간이라 보정 불필요, 20:00~익일 08:00 은 거래 없음.
 */
export function isExtendedHoursKst(now: Date): boolean {
  // KST = UTC+9 (DST 없음). 주말 제외.
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  const day = kst.getUTCDay();           // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const preMarket = minutes >= 8 * 60 && minutes < 9 * 60;            // 08:00~09:00
  const afterMarket = minutes >= 15 * 60 + 30 && minutes < 20 * 60;   // 15:30~20:00
  return preMarket || afterMarket;
}

/** 손익률 폴백 — KIS 가 0 으로 주는 장전 구간에서도 헤드라인 % 가 0.00 으로 죽지 않게. */
export function resolveProfitRate(rate: number, profitLoss: number, purchase: number): number {
  if (Math.abs(rate) >= 0.005) return rate;
  if (purchase > 0 && profitLoss !== 0) {
    return Math.round((profitLoss / purchase) * 10000) / 100;
  }
  return rate;
}

interface InquirePriceOutput {
  rt_cd?: string;
  output?: { stck_prpr?: string; antc_cnpr?: string };
}

/**
 * 장전·장후 보정용 종목 현재가 — KIS 앱과 같은 KRX+NXT 통합('UN') 시세 우선,
 * 미지원/실패 시 KRX('J')의 예상체결가(antc_cnpr, 장전 동시호가용) 폴백.
 * 둘 다 없으면 null(원값 유지). 모든 호출은 rate-limit 큐 경유.
 */
async function fetchUnifiedPrice(
  ticker: string,
  token: string,
  appKey: string,
  appSecret: string,
  baseUrl: string,
): Promise<number | null> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: 'FHKST01010100',
    custtype: 'P',
  };

  for (const div of ['UN', 'J'] as const) {
    const params = new URLSearchParams({ fid_cond_mrkt_div_code: div, fid_input_iscd: ticker });
    const { ok, data } = await kisFetchJson<InquirePriceOutput>(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
      { headers },
      `ext-${div}-${ticker}`,
      1, // 장전·장후 보정은 best-effort — 재시도 1회만
    );
    if (!ok || !data?.output) continue;
    if (div === 'UN') {
      const prpr = Number(data.output.stck_prpr);
      if (Number.isFinite(prpr) && prpr > 0) return prpr;
    } else {
      const antc = Number(data.output.antc_cnpr);
      if (Number.isFinite(antc) && antc > 0) return antc;
    }
  }
  return null;
}

/**
 * 실계좌 잔고 조회. force=false 면 5초 캐시 사용.
 * 실패(rate-limit 등) + 캐시 있으면 stale 캐시 반환, 없으면 null.
 */
export async function getKisBalance(force = false): Promise<KisBalance | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache.data;

  const settings = getSettings();
  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret || !settings.kisAccountNo) return null;

  try {
    const token = await getAccessToken();
    const trId = settings.kisVirtual ? 'VTTC8434R' : 'TTTC8434R';
    const params = new URLSearchParams({
      CANO: settings.kisAccountNo,
      ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    });

    const { ok, data } = await kisFetchJson<{
      rt_cd?: string;
      output1?: Array<Record<string, string>>;
      output2?: Array<Record<string, string>>;
    }>(
      `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      },
      'kisBalance-inquire-balance',
    );

    if (!ok || !data) {
      return cache ? { ...cache.data, stale: true } : null;
    }

    const holdings: KisHolding[] = (data.output1 || [])
      .filter((item) => Number(item.hldg_qty) > 0)
      .map((item) => ({
        ticker: item.pdno,
        name: item.prdt_name,
        quantity: Number(item.hldg_qty),
        avgPrice: Math.round(Number(item.pchs_avg_pric)),
        currentPrice: Number(item.prpr),
        profitLossRate: Number(item.evlu_pfls_rt),
        totalValue: Number(item.evlu_amt),
      }));

    const summary = data.output2?.[0] || {};
    const krwDeposit = Number(summary.dnca_tot_amt || 0);
    let orderableAmount = krwDeposit;
    try {
      const available = await getDomesticOrderableAmount();
      if (available > 0) orderableAmount = available;
    } catch {
      /* 폴백: 예수금 */
    }

    const totalPurchaseAmount = Number(summary.pchs_amt_smtl_amt || 0);
    let totalEvalAmount = Number(summary.evlu_amt_smtl_amt || 0);
    let totalProfitLoss = Number(summary.evlu_pfls_smtl_amt || 0);
    let rawRate = Number(summary.tot_evlu_pfls_rt || 0);

    // v6.0.8 장전·장후 보정 — KRX 정규장 밖(08:00~09:00 프리마켓, 15:30~20:00 NXT
    // 애프터마켓)에는 inquire-balance 가 KRX 종가/전일종가에 고정되어 KIS 앱(KRX+NXT
    // 통합가 평가)과 어긋남. 앱과 같은 통합 시세로 종목별 보정하고 합계도 보정분
    // 기준으로 재계산해 화면이 자기모순 없게 만든다.
    const extendedHours = isExtendedHoursKst(new Date());
    if (extendedHours && holdings.length > 0) {
      let anyOverride = false;
      for (const h of holdings) {
        const live = await fetchUnifiedPrice(h.ticker, token, appKey, appSecret, baseUrl);
        if (live !== null && live !== h.currentPrice) {
          h.currentPrice = live;
          h.totalValue = Math.round(live * h.quantity);
          h.profitLossRate = h.avgPrice > 0
            ? Math.round(((live - h.avgPrice) / h.avgPrice) * 10000) / 100
            : h.profitLossRate;
          anyOverride = true;
        }
      }
      if (anyOverride) {
        totalEvalAmount = holdings.reduce((a, h) => a + h.totalValue, 0);
        totalProfitLoss = totalEvalAmount - totalPurchaseAmount;
        rawRate = 0; // 아래 폴백이 보정된 손익으로 재계산
      }
    }

    const result: KisBalance = {
      holdings,
      totalPurchaseAmount,
      totalEvalAmount,
      totalProfitLoss,
      // 장전 등 KIS 가 0% 로 주는 구간에도 헤드라인이 0.00% 로 죽지 않게 폴백 계산
      totalProfitLossRate: resolveProfitRate(rawRate, totalProfitLoss, totalPurchaseAmount),
      depositAmount: krwDeposit,
      orderableAmount,
      fetchedAt: new Date().toISOString(),
      extendedHours,
    };
    cache = { data: result, at: Date.now() };
    return result;
  } catch {
    return cache ? { ...cache.data, stale: true } : null;
  }
}
