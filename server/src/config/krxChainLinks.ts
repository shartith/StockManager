/**
 * KRX 섹터 체인링크.
 *
 * 원리: 1차 섹터(주도주)가 강세면 후방산업/연관산업도 모니터링 대상.
 * 예: AI/반도체 강세 → 데이터센터 전력 수요 증가 → 유틸리티 → 인프라 소재
 *
 *   primary  : 사용자 정의 1차 시그널 섹터
 *   secondary: 1차 강세에 직접 후행하는 섹터 (가중치 0.6)
 *   tertiary : 더 멀리 파생되는 섹터        (가중치 0.3)
 *
 * 동일 섹터가 다른 1차에서 secondary/tertiary 로도 나오면 가장 큰 가중치 채택.
 */

export interface ChainLink {
  secondary: readonly string[];
  tertiary: readonly string[];
}

export const KRX_CHAIN_LINKS: Record<string, ChainLink> = {
  // AI 수요 → 데이터센터 전력 → HBM/패키징 소재
  'AI/반도체': {
    secondary: ['유틸리티'],
    tertiary:  ['소재', '산업재'],
  },
  // 2차전지 → 양/음극재 등 소재 → 완성차 EV 라인
  '2차전지/에너지': {
    secondary: ['소재'],
    tertiary:  ['자동차'],
  },
  // 자동차(EV/하이브리드) → 배터리 → 부품 소재
  '자동차': {
    secondary: ['2차전지/에너지'],
    tertiary:  ['소재'],
  },
  // 산업재(조선/건설/플랜트) → 후방 소재
  '산업재': {
    secondary: ['소재'],
    tertiary:  [],
  },
  // 항공우주/방위 → 산업재 후방 → 소재
  '항공우주/방위': {
    secondary: ['산업재'],
    tertiary:  ['소재'],
  },
  // IT/플랫폼 (네이버/카카오 등) → 광고/소비재 회복 신호로 약하게 연결
  'IT/플랫폼': {
    secondary: [],
    tertiary:  ['소비재'],
  },
  // 금융, 바이오/헬스, 소비재, 소재, 유틸리티 — 명시적 후방 링크 없음
  '금융':       { secondary: [], tertiary: [] },
  '바이오/헬스':{ secondary: [], tertiary: [] },
  '소비재':     { secondary: [], tertiary: [] },
  '소재':       { secondary: [], tertiary: [] },
  '유틸리티':   { secondary: [], tertiary: [] },
};

export const CHAIN_WEIGHTS = {
  primary:   1.0,
  secondary: 0.6,
  tertiary:  0.3,
} as const;
