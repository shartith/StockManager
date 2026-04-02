/**
 * DART OpenAPI 서비스
 * - 재무제표 조회 (매출, 영업이익, ROE 등)
 * - 실시간 공시 조회
 * - 종목코드 → DART 고유번호 매핑
 */

import { getSettings } from './settings';
import { queryOne, queryAll, execute } from '../db';
import { kisApiCall } from './apiQueue';

const DART_BASE = 'https://opendart.fss.or.kr/api';

// ─── DART 고유번호 매핑 캐시 ────────────────────────────

const corpCodeCache = new Map<string, string>();

/** 종목명으로 DART 고유번호 조회 */
async function lookupCorpCode(ticker: string): Promise<string | null> {
  // DB 캐시 확인
  const cached = queryOne('SELECT dart_code FROM stocks WHERE ticker = ? AND dart_code IS NOT NULL', [ticker]);
  if (cached?.dart_code) {
    corpCodeCache.set(ticker, cached.dart_code);
    return cached.dart_code;
  }

  // 메모리 캐시
  if (corpCodeCache.has(ticker)) return corpCodeCache.get(ticker)!;

  const settings = getSettings();
  if (!settings.dartApiKey) return null;

  // DART API로 회사명 검색
  const stock = queryOne('SELECT name FROM stocks WHERE ticker = ?', [ticker]);
  if (!stock?.name) return null;

  try {
    const params = new URLSearchParams({
      crtfc_key: settings.dartApiKey,
      corp_name: stock.name,
    });

    const res = await fetch(`${DART_BASE}/company.json?${params}`);
    if (!res.ok) return null;
    const data: any = await res.json();

    if (data.status === '000' && data.corp_code) {
      const code = data.corp_code;
      corpCodeCache.set(ticker, code);
      execute('UPDATE stocks SET dart_code = ? WHERE ticker = ?', [code, ticker]);
      return code;
    }

    // company.json 실패 시 list.json으로 대안 검색
    const listParams = new URLSearchParams({
      crtfc_key: settings.dartApiKey,
      corp_name: stock.name,
      page_count: '1',
    });
    const listRes = await fetch(`${DART_BASE}/list.json?${listParams}`);
    if (listRes.ok) {
      const listData: any = await listRes.json();
      if (listData.status === '000' && listData.list?.length > 0) {
        const code = listData.list[0].corp_code;
        if (code) {
          corpCodeCache.set(ticker, code);
          execute('UPDATE stocks SET dart_code = ? WHERE ticker = ?', [code, ticker]);
          return code;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** DART 고유번호 조회 (캐시 우선) */
export async function getDartCorpCode(ticker: string): Promise<string | null> {
  return lookupCorpCode(ticker);
}

// ─── 재무제표 조회 ──────────────────────────────────────

export interface DartFinancials {
  revenue?: number;          // 매출액 (억원)
  revenueGrowth?: number;   // 매출 YoY 성장률 (%)
  operatingIncome?: number;  // 영업이익 (억원)
  operatingMargin?: number;  // 영업이익률 (%)
  netIncome?: number;        // 순이익 (억원)
  totalAssets?: number;      // 자산총계 (억원)
  totalEquity?: number;      // 자본총계 (억원)
  roe?: number;              // ROE (%)
  reportDate?: string;       // 보고서 기준일
}

const financialCache = new Map<string, { data: DartFinancials; fetchedAt: number }>();
const FINANCIAL_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7일

/** DART 재무제표 조회 */
export async function getDartFinancials(ticker: string): Promise<DartFinancials | null> {
  const settings = getSettings();
  if (!settings.dartEnabled || !settings.dartApiKey) return null;
  if (ticker.length !== 6) return null; // KRX 종목만

  const cached = financialCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < FINANCIAL_CACHE_TTL) return cached.data;

  const corpCode = await getDartCorpCode(ticker);
  if (!corpCode) return null;

  try {
    const year = new Date().getFullYear() - 1; // 전년도 연간
    const params = new URLSearchParams({
      crtfc_key: settings.dartApiKey,
      corp_code: corpCode,
      bsns_year: String(year),
      reprt_code: '11011', // 연간보고서
      fs_div: 'CFS', // 연결재무제표
    });

    const res = await fetch(`${DART_BASE}/fnlttSinglAcntAll.json?${params}`);
    if (!res.ok) return null;
    const data: any = await res.json();

    if (data.status !== '000' || !data.list) {
      // 연결재무제표 실패 시 개별재무제표 시도
      params.set('fs_div', 'OFS');
      const res2 = await fetch(`${DART_BASE}/fnlttSinglAcntAll.json?${params}`);
      if (!res2.ok) return null;
      const data2: any = await res2.json();
      if (data2.status !== '000' || !data2.list) return null;
      return parseFinancials(data2.list, year, ticker);
    }

    return parseFinancials(data.list, year, ticker);
  } catch {
    return null;
  }
}

function parseFinancials(list: any[], year: number, ticker: string): DartFinancials | null {
  // DART 계정명으로 당기/전기 금액 찾기
  function findItem(accountNm: string, sjDiv?: string): any | null {
    return list.find((i: any) =>
      i.account_nm?.includes(accountNm) && (!sjDiv || i.sj_div === sjDiv)
    ) || null;
  }

  function parseAmt(val: string | undefined): number | null {
    if (!val) return null;
    const n = Number(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  const revenueItem = findItem('매출', 'IS') || findItem('수익(매출액)', 'IS');
  const opIncomeItem = findItem('영업이익', 'IS');
  const netIncomeItem = findItem('당기순이익', 'IS') || findItem('순이익', 'IS');
  const totalAssetsItem = findItem('자산총계', 'BS');
  const totalEquityItem = findItem('자본총계', 'BS');

  // 당기 (thstrm) + 전기 (frmtrm) 추출
  const revenue = parseAmt(revenueItem?.thstrm_amount);
  const revenuePrev = parseAmt(revenueItem?.frmtrm_amount);
  const operatingIncome = parseAmt(opIncomeItem?.thstrm_amount);
  const netIncome = parseAmt(netIncomeItem?.thstrm_amount);
  const totalAssets = parseAmt(totalAssetsItem?.thstrm_amount);
  const totalEquity = parseAmt(totalEquityItem?.thstrm_amount);

  const result: DartFinancials = { reportDate: `${year}-12-31` };

  // 단위 변환 (원 → 억원)
  const toEok = (v: number) => Math.round(v / 100000000);

  if (revenue) result.revenue = toEok(revenue);
  if (operatingIncome) result.operatingIncome = toEok(operatingIncome);
  if (netIncome) result.netIncome = toEok(netIncome);
  if (totalAssets) result.totalAssets = toEok(totalAssets);
  if (totalEquity) result.totalEquity = toEok(totalEquity);

  // 매출 YoY 성장률
  if (revenue && revenuePrev && revenuePrev !== 0) {
    result.revenueGrowth = Math.round(((revenue - revenuePrev) / Math.abs(revenuePrev)) * 10000) / 100;
  }

  // ROE = 순이익 / 자본총계 × 100
  if (netIncome && totalEquity && totalEquity !== 0) {
    result.roe = Math.round((netIncome / totalEquity) * 10000) / 100;
  }

  // 영업이익률 = 영업이익 / 매출 × 100
  if (operatingIncome && revenue && revenue !== 0) {
    result.operatingMargin = Math.round((operatingIncome / revenue) * 10000) / 100;
  }

  financialCache.set(ticker, { data: result, fetchedAt: Date.now() });
  return result;
}

// ─── 공시 조회 ──────────────────────────────────────────

export interface DartDisclosure {
  corpCode: string;
  corpName: string;
  title: string;
  reportDate: string;
  disclosureType: string;
  url: string;
  isImportant: boolean;
}

/** 최근 공시 조회 */
export async function getDartDisclosures(ticker: string, days: number = 7): Promise<DartDisclosure[]> {
  const settings = getSettings();
  if (!settings.dartEnabled || !settings.dartApiKey) return [];
  if (ticker.length !== 6) return [];

  const corpCode = await getDartCorpCode(ticker);
  if (!corpCode) return [];

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

    const params = new URLSearchParams({
      crtfc_key: settings.dartApiKey,
      corp_code: corpCode,
      bgn_de: fmt(startDate),
      end_de: fmt(endDate),
      page_count: '10',
    });

    const res = await fetch(`${DART_BASE}/list.json?${params}`);
    if (!res.ok) return [];
    const data: any = await res.json();

    if (data.status !== '000' || !data.list) return [];

    const importantTypes = ['주요사항보고', '합병등종료보고서', '최대주주변경', '자기주식취득'];

    return data.list.map((item: any) => {
      const isImportant = importantTypes.some(t => item.report_nm?.includes(t)) ||
        item.report_nm?.includes('실적') || item.report_nm?.includes('영업');

      return {
        corpCode: item.corp_code,
        corpName: item.corp_name,
        title: item.report_nm || '',
        reportDate: item.rcept_dt || '',
        disclosureType: item.pblntf_ty || '',
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
        isImportant,
      };
    });
  } catch {
    return [];
  }
}
