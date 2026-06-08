/**
 * KIS 거래내역 조회 (inquire-daily-ccld).
 *
 * v5.6.3: 잔고 동기화 시 KIS 가중평단이 아닌 실제 체결가로 BUY/SELL 을 입력하기
 * 위해 사용. 3개월 이내 데이터만 지원 (tr_id TTTC8001R / VTTC8001R).
 *
 * 한 주문(odno) 당 1건의 KisTrade 로 정규화한다. 부분체결은 KIS 가 이미
 * tot_ccld_qty + avg_prvs(체결 가중평균가) 로 집계해 주므로 그대로 사용.
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { kisFetchJson } from './kisHttp';
import logger from '../logger';
import type { KisTrade } from './portfolioReconcile';

interface KisCcldOutputRow {
  ord_dt: string;        // 주문일자 YYYYMMDD
  odno: string;          // 주문번호
  pdno: string;          // 상품번호 (종목코드)
  prdt_name: string;     // 상품명
  sll_buy_dvsn_cd: string; // '01'=매도, '02'=매수
  tot_ccld_qty: string;  // 총체결수량
  avg_prvs: string;      // 평균가 (체결 가중평균)
  cncl_yn: string;       // 취소여부 Y/N
  tot_ccld_amt: string;  // 총체결금액
}

/**
 * YYYYMMDD 포맷 변환.
 */
function fmtKisDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function kisDateToIso(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * KIS 일별주문체결 조회. 페이지네이션(CTX_AREA_NK100/FK100) 처리.
 * - lookbackDays: 오늘 기준 며칠 이전까지 (기본 90, KIS 제한)
 * - ticker: 특정 종목으로 필터 (빈 값이면 전체)
 */
export async function fetchKisTradeHistory(
  lookbackDays: number = 90,
  ticker: string = '',
): Promise<KisTrade[]> {
  const settings = getSettings();
  const { appKey, appSecret, baseUrl } = getKisConfig();
  if (!appKey || !appSecret || !settings.kisAccountNo) {
    return [];
  }

  const trId = settings.kisVirtual ? 'VTTC8001R' : 'TTTC8001R';
  const today = new Date();
  const start = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const inqrStrtDt = fmtKisDate(start);
  const inqrEndDt = fmtKisDate(today);

  const trades: KisTrade[] = [];
  let ctxAreaFk100 = '';
  let ctxAreaNk100 = '';
  let pageGuard = 0;
  const MAX_PAGES = 20; // 안전망 (KIS 한 페이지 50건 × 20 = 1000건)

  try {
    const token = await getAccessToken();

    while (pageGuard < MAX_PAGES) {
      pageGuard += 1;
      const params = new URLSearchParams({
        CANO: settings.kisAccountNo,
        ACNT_PRDT_CD: settings.kisAccountProductCode || '01',
        INQR_STRT_DT: inqrStrtDt,
        INQR_END_DT: inqrEndDt,
        SLL_BUY_DVSN_CD: '00', // 전체 (매도+매수)
        INQR_DVSN: '00',        // 역순(최신순)
        PDNO: ticker,
        CCLD_DVSN: '01',        // 체결만
        ORD_GNO_BRNO: '',
        ODNO: '',
        INQR_DVSN_3: '00',
        INQR_DVSN_1: '',
        CTX_AREA_FK100: ctxAreaFk100,
        CTX_AREA_NK100: ctxAreaNk100,
      });

      const { ok, data } = await kisFetchJson<{
        rt_cd?: string;
        msg1?: string;
        output1?: KisCcldOutputRow[];
        ctx_area_fk100?: string;
        ctx_area_nk100?: string;
        tr_cont?: string;
      }>(
        `${baseUrl}/uapi/domestic-stock/v1/trading/inquire-daily-ccld?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
            // tr_cont: 첫 페이지 '', 다음 페이지 'N'
            tr_cont: ctxAreaNk100 ? 'N' : '',
            custtype: 'P',
          },
        },
        'inquire-daily-ccld',
      );

      if (!ok || !data) {
        logger.warn({ msg: data?.msg1, rt_cd: data?.rt_cd }, 'fetchKisTradeHistory KIS error');
        break;
      }

      for (const row of (data.output1 || [])) {
        if (row.cncl_yn === 'Y') continue; // 취소된 주문 제외
        const qty = Number(row.tot_ccld_qty);
        const price = Number(row.avg_prvs);
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) continue;
        trades.push({
          ticker: row.pdno,
          odno: row.odno,
          type: row.sll_buy_dvsn_cd === '02' ? 'BUY' : 'SELL',
          quantity: qty,
          price: Math.round(price),
          date: kisDateToIso(row.ord_dt),
        });
      }

      // 다음 페이지 여부 — tr_cont 'M' 이면 더 있음, 'D'/'E'/'F' 이면 마지막
      const next = (data.tr_cont || '').trim();
      if (next !== 'M' && next !== 'F') break;
      ctxAreaFk100 = data.ctx_area_fk100 || '';
      ctxAreaNk100 = data.ctx_area_nk100 || '';
      if (!ctxAreaNk100) break;
    }

    return trades;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'fetchKisTradeHistory exception');
    return [];
  }
}

/**
 * 거래내역을 ticker → KisTrade[] 맵으로 정리. balanceSync 의 deps.fetchKisTrades
 * 가 종목별로 동기적으로 호출되므로, 한 번 가져온 다음 메모리에 캐싱해야 한다.
 */
export function indexTradesByTicker(trades: KisTrade[]): Map<string, KisTrade[]> {
  const m = new Map<string, KisTrade[]>();
  for (const t of trades) {
    const arr = m.get(t.ticker);
    if (arr) arr.push(t);
    else m.set(t.ticker, [t]);
  }
  return m;
}
