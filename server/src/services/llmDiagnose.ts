/**
 * LLM 일관성 진단.
 *
 * 사용자가 설정한 LLM 이 학습된 상식적 시장 판단을 갖췄는지 검증.
 * 3 가지 명확한 시나리오 (강세 / 약세 / 중립) 에 대해 BUY/SELL/HOLD 판단을
 * 받아내고, 사전 정의된 정답과 비교한다.
 *
 * 매매 룰의 LLM 의존부 (Rule 12 breakout, news 요약) 가 제대로 동작하려면
 * 모델이 최소한 이 정도 판단력은 갖추고 있어야 한다는 sanity check.
 */

import { getSettings } from './settings';
import { callLlm } from './llm';
import logger from '../logger';

export type Verdict = 'BUY' | 'SELL' | 'HOLD';

export interface DiagnosisCase {
  id: string;
  title: string;
  scenario: string;
  expected: Verdict;
  expectedRationale: string;
}

export interface DiagnosisResult {
  caseId: string;
  title: string;
  expected: Verdict;
  llmVerdict: Verdict | 'PARSE_ERROR';
  llmReason: string;
  match: boolean;
  rawResponse: string;
  latencyMs: number;
  error?: string;
}

export interface DiagnosisSummary {
  llmConfigured: boolean;
  llmModel: string;
  llmUrl: string;
  totalCases: number;
  passed: number;
  passRate: number;
  overallVerdict: 'CONSISTENT' | 'PARTIAL' | 'INCONSISTENT' | 'UNAVAILABLE';
  cases: DiagnosisResult[];
  finishedAt: string;
}

const TEST_CASES: DiagnosisCase[] = [
  {
    id: 'bullish_breakout',
    title: '강세 돌파 — 매수 시그널',
    scenario: `
종목: 삼성전자 (005930), 섹터: AI/반도체
시초가 대비: +1.8% (현재 70,800원, 시초가 69,550원)
오전 누적 거래량: 5일 평균의 1.7배
RSI(14): 55 (중립~강세 영역)
5일 이동평균: 70,200원 (현재가 위)
20일 이동평균: 68,400원 (5MA > 20MA, 정배열)
직전 봉: 장대양봉 (꼬리 짧음, body/range 0.85)
업종 모멘텀: SOXX 어젯밤 +2.4% (강세)
호가 스프레드: 0.05% (양호)
시장: KOSPI +1.0%, VIX 안정`.trim(),
    expected: 'BUY',
    expectedRationale: '시초가 +1% 통과, 거래량 1.5x 이상, 추세 정배열, 장대양봉, 섹터 강세 — 모든 진입 게이트 통과',
  },
  {
    id: 'bearish_topping',
    title: '약세 천장 패턴 — 매도/회피',
    scenario: `
종목: 임의 KRX 종목, 섹터: 2차전지/에너지
시초가 대비: -0.5% (전일 종가 대비 하락 출발)
오전 누적 거래량: 5일 평균의 0.4배 (저조)
RSI(14): 78 (과매수 영역)
5일 이동평균: 현재가 아래 (이격도 -2.1%)
20일 이동평균: 현재가 위 (역배열 진행)
직전 봉: bearish engulfing (음봉이 직전 양봉 완전 포함)
업종 모멘텀: ICLN 어젯밤 -1.8%
호가 스프레드: 0.6% (넓음, 매수 호가 얇음)
시장: KOSPI -0.8%, VIX 상승`.trim(),
    expected: 'SELL',
    expectedRationale: 'RSI 과매수 + bearish engulfing + 거래량 감소 + 시장 약세 — 보유 종목이면 매도, 미보유면 진입 회피',
  },
  {
    id: 'neutral_chop',
    title: '횡보·관망 — 보유',
    scenario: `
종목: 임의 KRX 종목, 섹터: 금융
시초가 대비: +0.1% (거의 변동 없음)
오전 누적 거래량: 5일 평균의 0.95배 (평균)
RSI(14): 49 (중립)
5일 이동평균과 20일 이동평균: 거의 동일 (수렴)
직전 봉: 도지 (시가/종가 차이 < 0.1%)
업종 모멘텀: XLF 어젯밤 +0.3% (약한 양봉)
호가 스프레드: 0.1% (정상)
시장: KOSPI +0.05%, VIX 평이
포지션 상태: 이미 보유 중, 평단 대비 +0.4%`.trim(),
    expected: 'HOLD',
    expectedRationale: '추세 부재, 거래량 평이, 도지 캔들, 시장 무방향 — 진입 트리거 없고, 보유분도 매도 룰 미발동 영역',
  },
];

const SYSTEM_PROMPT = `당신은 한국 주식 단기 매매 분석가입니다.
주어진 시나리오를 보고 BUY / SELL / HOLD 중 하나를 선택하세요.
- BUY: 신규 진입 권장 또는 보유 시 추가 매수
- SELL: 보유 시 매도 또는 신규 진입 회피
- HOLD: 진입 트리거 없음 / 보유분도 매도 룰 미발동

반드시 valid JSON 만 출력. 다른 설명 금지.
형식: {"verdict":"BUY|SELL|HOLD","reason":"한 줄 사유 (50자 이내)"}`;

function parseLlmResponse(raw: string): { verdict: Verdict | 'PARSE_ERROR'; reason: string } {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(cleaned);
    const v = String(obj.verdict || '').toUpperCase().trim();
    if (v === 'BUY' || v === 'SELL' || v === 'HOLD') {
      return { verdict: v, reason: String(obj.reason || '').slice(0, 200) };
    }
    return { verdict: 'PARSE_ERROR', reason: `Unknown verdict: ${v}` };
  } catch {
    // Fallback: 본문에서 BUY/SELL/HOLD 키워드 탐지
    const upper = cleaned.toUpperCase();
    for (const v of ['BUY', 'SELL', 'HOLD'] as const) {
      if (upper.includes(v)) return { verdict: v, reason: cleaned.slice(0, 200) };
    }
    return { verdict: 'PARSE_ERROR', reason: cleaned.slice(0, 200) };
  }
}

async function runOneCase(c: DiagnosisCase): Promise<DiagnosisResult> {
  const settings = getSettings();
  const t0 = Date.now();
  try {
    const raw = await callLlm(
      settings.llmModel,
      settings.llmUrl,
      `다음 시나리오를 보고 판단하세요:\n${c.scenario}`,
      SYSTEM_PROMPT,
      300,
      settings.llmApiKey,
    );
    const latencyMs = Date.now() - t0;
    const { verdict, reason } = parseLlmResponse(raw);
    return {
      caseId: c.id,
      title: c.title,
      expected: c.expected,
      llmVerdict: verdict,
      llmReason: reason,
      match: verdict === c.expected,
      rawResponse: raw.slice(0, 500),
      latencyMs,
    };
  } catch (err) {
    return {
      caseId: c.id,
      title: c.title,
      expected: c.expected,
      llmVerdict: 'PARSE_ERROR',
      llmReason: '',
      match: false,
      rawResponse: '',
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

export async function runLlmDiagnostics(): Promise<DiagnosisSummary> {
  const settings = getSettings();
  const baseSummary = {
    llmConfigured: !!settings.llmUrl,
    llmModel: settings.llmModel || '(auto-detect)',
    llmUrl: settings.llmUrl || '',
    totalCases: TEST_CASES.length,
    finishedAt: new Date().toISOString(),
  };

  if (!settings.llmEnabled || !settings.llmUrl) {
    return {
      ...baseSummary,
      passed: 0,
      passRate: 0,
      overallVerdict: 'UNAVAILABLE',
      cases: [],
    };
  }

  // 순차 실행 (LLM 큐가 mutex 보장하므로 동시성 무의미)
  const cases: DiagnosisResult[] = [];
  for (const c of TEST_CASES) {
    const r = await runOneCase(c);
    cases.push(r);
    logger.info(
      { caseId: c.id, expected: c.expected, llm: r.llmVerdict, match: r.match, latencyMs: r.latencyMs },
      '[LLM Diagnose] case',
    );
  }

  const passed = cases.filter(c => c.match).length;
  const passRate = passed / cases.length;
  let overallVerdict: DiagnosisSummary['overallVerdict'];
  if (passRate >= 1.0) overallVerdict = 'CONSISTENT';
  else if (passRate >= 0.66) overallVerdict = 'PARTIAL';
  else overallVerdict = 'INCONSISTENT';

  return {
    ...baseSummary,
    passed,
    passRate,
    overallVerdict,
    cases,
  };
}
