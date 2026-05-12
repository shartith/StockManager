/**
 * 한국거래소 (KRX) 휴장일 캘린더.
 *
 * 토/일 외 휴장일에 cron 이 실행되면 KIS API 가 거부하므로
 * 사전에 회피한다. 임시공휴일은 KRX 발표 후 수동 추가 필요.
 *
 * 참고: https://krx.co.kr (휴장일 안내)
 */

const HOLIDAYS_2025 = new Set([
  '2025-01-01', // 신정
  '2025-01-27', // 임시공휴일 (설 연휴)
  '2025-01-28', // 설 연휴
  '2025-01-29', // 설날
  '2025-01-30', // 설 연휴
  '2025-03-01', // 삼일절 (토요일이므로 휴장 영향 없음)
  '2025-03-03', // 삼일절 대체
  '2025-05-05', // 어린이날
  '2025-05-06', // 부처님 오신 날
  '2025-06-03', // 대통령선거일
  '2025-06-06', // 현충일
  '2025-08-15', // 광복절
  '2025-10-03', // 개천절 (금)
  '2025-10-06', // 추석 연휴 시작
  '2025-10-07', // 추석
  '2025-10-08', // 추석 연휴
  '2025-10-09', // 한글날
  '2025-12-25', // 성탄절
  '2025-12-31', // 연말 휴장 (KRX 관례)
]);

const HOLIDAYS_2026 = new Set([
  '2026-01-01', // 신정
  '2026-02-16', // 설 연휴 (월)
  '2026-02-17', // 설날 (화)
  '2026-02-18', // 설 연휴 (수)
  '2026-03-01', // 삼일절 (일요일, 휴장 영향 없음)
  '2026-03-02', // 삼일절 대체 (월)
  '2026-04-15', // 국회의원선거일 (예상)
  '2026-05-01', // 근로자의 날
  '2026-05-05', // 어린이날
  '2026-05-25', // 부처님 오신 날
  '2026-06-06', // 현충일 (토, 휴장 영향 없음)
  '2026-08-15', // 광복절 (토, 휴장 영향 없음)
  '2026-09-24', // 추석 연휴 시작 (목)
  '2026-09-25', // 추석 (금)
  '2026-09-28', // 추석 대체 (월)
  '2026-10-03', // 개천절 (토, 휴장 영향 없음)
  '2026-10-09', // 한글날 (금)
  '2026-12-25', // 성탄절 (금)
  '2026-12-31', // 연말 휴장
]);

function formatDate(date: Date): string {
  const kst = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${kst.getFullYear()}-${String(kst.getMonth()+1).padStart(2,'0')}-${String(kst.getDate()).padStart(2,'0')}`;
}

/**
 * 한국거래소 휴장일 여부. KST 기준.
 * 토/일은 별도 처리 (cron 패턴 1-5 로 제외하지만 안전망).
 */
export function isKrxHoliday(date: Date = new Date()): boolean {
  const kst = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const dow = kst.getDay();
  if (dow === 0 || dow === 6) return true; // 일/토

  const ymd = formatDate(date);
  return HOLIDAYS_2025.has(ymd) || HOLIDAYS_2026.has(ymd);
}

/**
 * 오늘이 거래일인지 (휴장일 아님).
 */
export function isKrxTradingDay(date: Date = new Date()): boolean {
  return !isKrxHoliday(date);
}
