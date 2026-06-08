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
}

let cache: { data: KisBalance; at: number } | null = null;
const CACHE_TTL = 5_000;

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

    const result: KisBalance = {
      holdings,
      totalPurchaseAmount: Number(summary.pchs_amt_smtl_amt || 0),
      totalEvalAmount: Number(summary.evlu_amt_smtl_amt || 0),
      totalProfitLoss: Number(summary.evlu_pfls_smtl_amt || 0),
      totalProfitLossRate: Number(summary.tot_evlu_pfls_rt || 0),
      depositAmount: krwDeposit,
      orderableAmount,
      fetchedAt: new Date().toISOString(),
    };
    cache = { data: result, at: Date.now() };
    return result;
  } catch {
    return cache ? { ...cache.data, stale: true } : null;
  }
}
