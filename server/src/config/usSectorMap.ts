/**
 * US 섹터 ETF → KRX 섹터 매핑.
 *
 * 한국 시장은 미국 마감의 후행성이 강하기 때문에, 전일 미국 마감의 섹터 ETF
 * 변동을 KRX 섹터 신호로 변환해 prefetch 한다 (08:30 cron).
 *
 * 매핑 원칙:
 *   - 1차 매핑은 KRX_TOP_STOCKS 의 sector 문자열과 정확히 일치해야 함
 *   - 한 ETF 가 여러 KRX 섹터에 걸치면 배열에 모두 나열 (가중치 동일)
 */

export interface UsEtfSignal {
  yahooTicker: string;
  name: string;
  /** KRX 섹터(KRX_TOP_STOCKS.sector 와 매치). */
  krxSectors: string[];
}

export const US_ETF_SIGNALS: readonly UsEtfSignal[] = [
  // 반도체 / AI
  { yahooTicker: 'SOXX', name: 'iShares Semiconductor',  krxSectors: ['AI/반도체'] },
  { yahooTicker: 'SMH',  name: 'VanEck Semiconductor',   krxSectors: ['AI/반도체'] },
  // 광범위 기술 — 반도체 + IT 플랫폼 동시 신호
  { yahooTicker: 'XLK',  name: 'Tech Select',            krxSectors: ['AI/반도체', 'IT/플랫폼'] },
  { yahooTicker: 'QQQ',  name: 'Nasdaq 100',             krxSectors: ['AI/반도체', 'IT/플랫폼'] },
  // 에너지 — 정유/2차전지 원소재
  { yahooTicker: 'XLE',  name: 'Energy Select',          krxSectors: ['소재'] },
  // 클린에너지 — KRX 2차전지 라인
  { yahooTicker: 'ICLN', name: 'iShares Global Clean Energy', krxSectors: ['2차전지/에너지'] },
  // 금융
  { yahooTicker: 'XLF',  name: 'Financial Select',       krxSectors: ['금융'] },
  // 헬스케어
  { yahooTicker: 'XLV',  name: 'Healthcare Select',      krxSectors: ['바이오/헬스'] },
  // 산업재 — 조선/건설/방위
  { yahooTicker: 'XLI',  name: 'Industrial Select',      krxSectors: ['산업재', '항공우주/방위'] },
  // 항공우주/방위 전용
  { yahooTicker: 'ITA',  name: 'iShares Aerospace & Defense', krxSectors: ['항공우주/방위'] },
  // 자유 소비재 → 자동차/소비재
  { yahooTicker: 'XLY',  name: 'Consumer Discretionary', krxSectors: ['자동차', '소비재'] },
  // EV (자동차/2차전지 동시)
  { yahooTicker: 'DRIV', name: 'Global X Autonomous & EV', krxSectors: ['자동차', '2차전지/에너지'] },
  // 필수 소비재
  { yahooTicker: 'XLP',  name: 'Consumer Staples',       krxSectors: ['소비재'] },
  // 소재
  { yahooTicker: 'XLB',  name: 'Materials Select',       krxSectors: ['소재'] },
  // 유틸리티 — AI 데이터센터 전력 수요와 연동
  { yahooTicker: 'XLU',  name: 'Utilities Select',       krxSectors: ['유틸리티'] },
];

/** 미국 ETF 가 "Hot" 으로 판정되는 변동률 임계값 (전일 종가 대비). */
export const US_HOT_THRESHOLD_PERCENT = 1.5;

/** 변동률을 가중치로 변환할 때 쓰는 정규화 분모.
 *  ex) ETF +3% 면 weight = min(3 / 1.5, 2.0) = 2.0 */
export const US_WEIGHT_NORMALIZER = US_HOT_THRESHOLD_PERCENT;
export const US_WEIGHT_CAP = 2.0;
