/**
 * Ollama 로컬 LLM 연동 서비스
 * 모델: sorc/qwen3.5-claude-4.6-opus
 *
 * 4개 시점별 정형화된 입력/출력:
 *   PRE_OPEN   — 장 시작 전: 매수 후보 탐색
 *   POST_OPEN  — 장 시작 30분 후: 매수 실행 여부 최종 판단
 *   PRE_CLOSE_1H — 장 마감 1시간 전: 보유 종목 매도 판단
 *   PRE_CLOSE_30M — 장 마감 30분 전: 미체결 정리 + 일일 요약
 */

import { getSettings } from './settings';
import { TechnicalIndicators, CandleData } from './technicalAnalysis';
import { buildAccuracyReport } from './signalAnalyzer';

// ─── 입력 데이터 정형화 ─────────────────────────────────────

/** LLM에 전달하는 정형화된 종목 데이터 */
export interface StockAnalysisInput {
  // 종목 기본 정보
  ticker: string;
  name: string;
  market: 'KRX' | 'NYSE' | 'NASDAQ';

  // 가격 정보
  currentPrice: number;
  previousClose: number;
  changePercent: number;

  // 보유 현황 (보유 중인 경우)
  holding?: {
    quantity: number;
    avgPrice: number;
    totalCost: number;
    unrealizedPnL: number;      // 미실현 손익
    unrealizedPnLPercent: number; // 미실현 손익률
    holdingDays: number;         // 보유 일수
  };

  // 기술적 지표
  indicators: {
    rsi14: number | null;
    sma5: number | null;
    sma20: number | null;
    sma60: number | null;
    sma120: number | null;
    ema12: number | null;
    ema26: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHistogram: number | null;
    bollingerUpper: number | null;
    bollingerMiddle: number | null;
    bollingerLower: number | null;
    technicalSignal: 'BUY' | 'SELL' | 'HOLD';
    technicalReasons: string[];
  };

  // 최근 5일 캔들 요약
  recentCandles: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    changePercent: number;
  }[];

  // 거래량 분석
  volumeAnalysis: {
    avgVolume20d: number;       // 20일 평균 거래량
    todayVsAvg: number;        // 오늘 거래량 / 20일 평균 (배수)
    volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
  };

  // 뉴스 요약
  newsSummary?: string;

  // 뉴스 감성 점수
  sentimentScore?: number;

  // 시장 동향
  marketContext?: string;

  // 포트폴리오 리스크 컨텍스트
  portfolioContext?: {
    totalInvested: number;
    holdingCount: number;
    currentProfitLossPercent: number;
    sectorConcentration: { sector: string; percent: number }[];
  };
}

/** 스케줄 시점 */
export type AnalysisPhase = 'PRE_OPEN' | 'POST_OPEN' | 'PRE_CLOSE_1H' | 'PRE_CLOSE_30M';

// ─── 출력 데이터 정형화 ─────────────────────────────────────

/** LLM 매매 판단 응답 */
export interface TradeDecision {
  // 핵심 판단
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;           // 0~100

  // 가격 전략
  targetPrice: number | null;   // 목표가
  stopLossPrice: number | null; // 손절가
  entryPrice: number | null;    // 진입 희망가 (BUY일 때)

  // 포지션 사이징
  suggestedRatio: number;       // 투자 비중 제안 (0~100%)
  urgency: 'IMMEDIATE' | 'WAIT_DIP' | 'GRADUAL' | 'NO_RUSH';

  // 판단 근거
  reasoning: string;            // 종합 판단 근거 (한국어)
  keyFactors: string[];         // 핵심 판단 요인 목록
  risks: string[];              // 리스크 요인 목록

  // 시간 프레임
  holdingPeriod: 'DAY_TRADE' | 'SWING' | 'SHORT_TERM' | 'MID_TERM';
}

// ─── Ollama 서비스 ──────────────────────────────────────────

/** Ollama 서버 연결 상태 확인 */
export async function checkOllamaStatus(): Promise<{ connected: boolean; models: string[] }> {
  const settings = getSettings();
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`);
    if (!res.ok) return { connected: false, models: [] };
    const data: any = await res.json();
    const models = (data.models || []).map((m: any) => m.name);
    return { connected: true, models };
  } catch {
    return { connected: false, models: [] };
  }
}

/** 정형화된 입력으로 LLM 매매 판단 요청 */
export async function getTradeDecision(
  input: StockAnalysisInput,
  phase: AnalysisPhase = 'PRE_OPEN',
): Promise<TradeDecision> {
  const settings = getSettings();

  if (!settings.ollamaEnabled) {
    throw new Error('Ollama가 비활성화되어 있습니다');
  }

  // 토론 모드: 강세/약세 분석 후 종합 판단 (3회 호출)
  if (settings.debateMode) {
    return getTradeDecisionWithDebate(input, phase, settings);
  }

  // 기본 모드: 단일 호출
  return getTradeDecisionSingle(input, phase, settings);
}

async function callOllama(model: string, url: string, prompt: string, system: string, numPredict: number = 1024): Promise<string> {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system,
      stream: false,
      format: 'json',
      options: { temperature: 0.2, num_predict: numPredict, top_p: 0.9 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama 요청 실패: ${await res.text()}`);
  const data: any = await res.json();
  return data.response || data.thinking || '';
}

async function getTradeDecisionSingle(input: StockAnalysisInput, phase: AnalysisPhase, settings: any): Promise<TradeDecision> {
  const prompt = buildStructuredPrompt(input, phase);
  const responseText = await callOllama(settings.ollamaModel, settings.ollamaUrl, prompt, buildSystemPrompt());
  console.log(`[Ollama] ${input.ticker} (${phase}) raw response length: ${responseText.length}`);
  return parseDecisionResponse(responseText, input);
}

async function getTradeDecisionWithDebate(input: StockAnalysisInput, phase: AnalysisPhase, settings: any): Promise<TradeDecision> {
  const dataBlock = formatInputData(input);
  const systemPrompt = buildSystemPrompt();

  // 1차: 강세(Bull) 분석
  const bullPrompt = `[강세 분석가 역할] 아래 종목 데이터를 검토하고, 매수(BUY) 관점에서 최대한 긍정적인 근거를 찾아 분석하세요.
상승 가능성, 기술적 반등 신호, 긍정적 뉴스, 저평가 요소 등을 중심으로 분석하세요.

${dataBlock}

반드시 JSON으로 응답: { "bullCase": "매수 근거 3~5문장", "bullConfidence": 0~100, "keyBullFactors": ["요소1", "요소2"] }`;

  const bullResponse = await callOllama(settings.ollamaModel, settings.ollamaUrl, bullPrompt, systemPrompt, 400);
  console.log(`[Ollama] ${input.ticker} Bull analysis done`);

  // 2차: 약세(Bear) 분석
  const bearPrompt = `[약세 분석가 역할] 아래 종목 데이터를 검토하고, 매도(SELL)/위험 관점에서 최대한 부정적인 근거를 찾아 분석하세요.
하락 위험, 기술적 과열 신호, 부정적 뉴스, 고평가 요소 등을 중심으로 분석하세요.

${dataBlock}

반드시 JSON으로 응답: { "bearCase": "매도/위험 근거 3~5문장", "bearConfidence": 0~100, "keyBearFactors": ["요소1", "요소2"] }`;

  const bearResponse = await callOllama(settings.ollamaModel, settings.ollamaUrl, bearPrompt, systemPrompt, 400);
  console.log(`[Ollama] ${input.ticker} Bear analysis done`);

  // 3차: 종합 판단
  const phaseInstruction = PHASE_INSTRUCTIONS[phase];
  const finalPrompt = `${phaseInstruction}

아래는 동일 종목에 대한 강세/약세 분석 결과입니다. 양측의 주장을 균형 있게 검토하여 최종 매매 결정을 내리세요.

[강세 분석]
${bullResponse}

[약세 분석]
${bearResponse}

[종목 데이터]
${dataBlock}

${RESPONSE_SCHEMA}`;

  const finalResponse = await callOllama(settings.ollamaModel, settings.ollamaUrl, finalPrompt, systemPrompt, 1024);
  console.log(`[Ollama] ${input.ticker} (${phase}) debate final response length: ${finalResponse.length}`);

  return parseDecisionResponse(finalResponse, input);
}

/** 기존 인터페이스 호환용 래퍼 (scheduler.ts 등에서 사용) */
export async function getTradeDecisionLegacy(
  ticker: string,
  name: string,
  indicators: TechnicalIndicators,
  newsSummary?: string,
  marketTrend?: string,
): Promise<TradeDecision> {
  const input: StockAnalysisInput = {
    ticker,
    name,
    market: 'KRX',
    currentPrice: indicators.currentPrice,
    previousClose: indicators.sma5 ?? indicators.currentPrice,
    changePercent: 0,
    indicators: {
      rsi14: indicators.rsi14,
      sma5: indicators.sma5,
      sma20: indicators.sma20,
      sma60: indicators.sma60,
      sma120: indicators.sma120,
      ema12: indicators.ema12,
      ema26: indicators.ema26,
      macd: indicators.macd,
      macdSignal: indicators.macdSignal,
      macdHistogram: indicators.macdHistogram,
      bollingerUpper: indicators.bollingerUpper,
      bollingerMiddle: indicators.bollingerMiddle,
      bollingerLower: indicators.bollingerLower,
      technicalSignal: indicators.signal,
      technicalReasons: indicators.signalReasons,
    },
    recentCandles: [],
    volumeAnalysis: { avgVolume20d: 0, todayVsAvg: 1, volumeTrend: 'STABLE' },
    newsSummary,
    marketContext: marketTrend,
  };

  return getTradeDecision(input, 'PRE_OPEN');
}

// ─── 시스템 프롬프트 ────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `당신은 한국/미국 주식시장 전문 트레이딩 AI입니다.
제공된 정형 데이터를 분석하여 매매 판단을 내립니다.

규칙:
1. 반드시 지정된 JSON 스키마로만 응답하세요.
2. 감정이 아닌 데이터 기반으로 판단하세요.
3. 불확실할 때는 HOLD를 선택하세요.
4. confidence가 60 미만이면 signal은 반드시 HOLD입니다.
5. 손절가는 진입가 대비 -3%~-7% 범위로 설정하세요.
6. 목표가는 리스크 대비 최소 2:1 수익비를 고려하세요.
7. 거래량이 평균 대비 급증하면 변동성 리스크로 반영하세요.
8. RSI 30 이하 = 과매도(매수 기회), RSI 70 이상 = 과매수(매도 고려).
9. MACD 골든크로스 = 상승 전환 신호, 데드크로스 = 하락 전환 신호.
10. 볼린저 밴드 하단 이탈 = 반등 가능, 상단 이탈 = 조정 가능.`;

// 정확도 리포트 캐시 (1시간)
let cachedAccuracyReport: string | null = null;
let reportCacheTime = 0;
const REPORT_CACHE_TTL = 3600_000; // 1시간

const INVESTMENT_STYLE_PROMPTS: Record<string, string> = {
  balanced: '', // 기본 프롬프트 그대로 사용
  value: `\n\n[투자 스타일: 가치투자]
- PER, PBR이 낮고 재무적으로 안정적인 기업을 선호하라.
- 단기 가격 변동보다 기업의 내재가치와 장기 성장성에 집중하라.
- 안전마진(현재가 대비 목표가 괴리)이 충분한 경우에만 매수를 권고하라.
- 고평가된 종목은 기술적 신호가 좋아도 보수적으로 판단하라.`,
  growth: `\n\n[투자 스타일: 성장투자]
- 매출/이익 성장률이 높은 혁신 기업을 선호하라.
- 높은 PER도 성장성이 뒷받침되면 허용하라.
- 시장을 선도하는 트렌드(AI, 바이오, 친환경 등) 관련 종목에 가산점을 부여하라.
- 성장 모멘텀이 꺾이는 신호(매출 감소, 가이던스 하향)에 민감하게 반응하라.`,
  momentum: `\n\n[투자 스타일: 모멘텀]
- 최근 상승 추세, 거래량 급증, 돌파 패턴에 집중하라.
- RSI가 높아도 추세가 강하면 매수를 유지하라 (RSI 70 이상에서도 추세 지속 가능).
- 이동평균 정배열 + 거래량 증가 조합에 높은 점수를 부여하라.
- 추세 이탈(지지선 붕괴, 거래량 감소) 시 즉시 매도를 권고하라.`,
};

/** 시스템 프롬프트 동적 생성 (투자 스타일 + 정확도 피드백) */
function buildSystemPrompt(): string {
  const settings = getSettings();
  const now = Date.now();
  if (now - reportCacheTime > REPORT_CACHE_TTL) {
    try {
      cachedAccuracyReport = buildAccuracyReport();
    } catch {
      cachedAccuracyReport = null;
    }
    reportCacheTime = now;
  }

  let prompt = BASE_SYSTEM_PROMPT;
  const stylePrompt = INVESTMENT_STYLE_PROMPTS[settings.investmentStyle] || '';
  if (stylePrompt) prompt += stylePrompt;
  if (cachedAccuracyReport) prompt += `\n\n${cachedAccuracyReport}`;
  return prompt;
}

// ─── 시점별 프롬프트 빌더 ───────────────────────────────────

function buildStructuredPrompt(input: StockAnalysisInput, phase: AnalysisPhase): string {
  const dataBlock = formatInputData(input);
  const phaseInstruction = PHASE_INSTRUCTIONS[phase];
  const responseSchema = RESPONSE_SCHEMA;

  return `${phaseInstruction}

────────────────────────────
[입력 데이터]
${dataBlock}
────────────────────────────

[응답 스키마]
아래 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요.
${responseSchema}`;
}

/** 입력 데이터를 정형화된 텍스트로 변환 */
function formatInputData(input: StockAnalysisInput): string {
  let text = `■ 종목: ${input.name} (${input.ticker}) [${input.market}]
■ 현재가: ${input.currentPrice.toLocaleString()} | 전일대비: ${input.changePercent >= 0 ? '+' : ''}${input.changePercent.toFixed(2)}%
`;

  // 보유 현황
  if (input.holding) {
    const h = input.holding;
    text += `
■ 보유현황:
  - 수량: ${h.quantity}주 | 평균단가: ${h.avgPrice.toLocaleString()} | 투자금: ${h.totalCost.toLocaleString()}
  - 미실현손익: ${h.unrealizedPnL >= 0 ? '+' : ''}${h.unrealizedPnL.toLocaleString()} (${h.unrealizedPnLPercent >= 0 ? '+' : ''}${h.unrealizedPnLPercent.toFixed(2)}%)
  - 보유일수: ${h.holdingDays}일
`;
  } else {
    text += `■ 보유현황: 미보유\n`;
  }

  // 기술 지표
  const ind = input.indicators;
  text += `
■ 기술적 지표:
  RSI(14): ${ind.rsi14 ?? '-'}
  이동평균: SMA5=${ind.sma5 ?? '-'} | SMA20=${ind.sma20 ?? '-'} | SMA60=${ind.sma60 ?? '-'} | SMA120=${ind.sma120 ?? '-'}
  MACD: ${ind.macd ?? '-'} / Signal: ${ind.macdSignal ?? '-'} / Histogram: ${ind.macdHistogram ?? '-'}
  볼린저: 상단=${ind.bollingerUpper ?? '-'} | 중간=${ind.bollingerMiddle ?? '-'} | 하단=${ind.bollingerLower ?? '-'}
  기술적판단: ${ind.technicalSignal} [${ind.technicalReasons.join(', ') || '해당없음'}]
`;

  // 최근 캔들
  if (input.recentCandles.length > 0) {
    text += `\n■ 최근 ${input.recentCandles.length}일 시세:\n`;
    text += `  날짜       | 시가      | 고가      | 저가      | 종가      | 거래량        | 등락\n`;
    text += `  -----------|-----------|-----------|-----------|-----------|--------------|------\n`;
    for (const c of input.recentCandles) {
      text += `  ${c.date} | ${c.open.toLocaleString().padStart(9)} | ${c.high.toLocaleString().padStart(9)} | ${c.low.toLocaleString().padStart(9)} | ${c.close.toLocaleString().padStart(9)} | ${c.volume.toLocaleString().padStart(12)} | ${c.changePercent >= 0 ? '+' : ''}${c.changePercent.toFixed(2)}%\n`;
    }
  }

  // 거래량 분석
  const vol = input.volumeAnalysis;
  text += `\n■ 거래량분석:
  20일평균: ${vol.avgVolume20d.toLocaleString()} | 금일배수: ${vol.todayVsAvg.toFixed(2)}배 | 추세: ${vol.volumeTrend === 'INCREASING' ? '증가' : vol.volumeTrend === 'DECREASING' ? '감소' : '보합'}
`;

  // 뉴스
  if (input.newsSummary) {
    text += `\n■ 뉴스요약:\n${input.newsSummary}\n`;
    if (input.sentimentScore !== undefined) {
      text += `  감성점수: ${input.sentimentScore > 0 ? '+' : ''}${input.sentimentScore}/100\n`;
    }
  }

  // 시장 동향
  if (input.marketContext) {
    text += `\n■ 시장동향:\n${input.marketContext}\n`;
  }

  // 포트폴리오 리스크 컨텍스트
  if (input.portfolioContext) {
    const pc = input.portfolioContext;
    text += `\n■ 포트폴리오 현황:
  - 총 투자금: ${pc.totalInvested.toLocaleString()}원 | 보유종목: ${pc.holdingCount}개
  - 총 손익률: ${pc.currentProfitLossPercent >= 0 ? '+' : ''}${pc.currentProfitLossPercent.toFixed(2)}%
`;
    if (pc.sectorConcentration.length > 0) {
      text += `  - 섹터 집중도: ${pc.sectorConcentration.map(s => `${s.sector} ${s.percent}%`).join(', ')}\n`;
    }
    text += `  ※ 리스크 규칙: 같은 섹터 30% 초과 집중 시 매수 보수적, 총 손실 -10% 초과 시 신규 매수 지양, 10종목 초과 시 추가 매수 지양\n`;
  }

  return text;
}

/** 시점별 지시문 */
const PHASE_INSTRUCTIONS: Record<AnalysisPhase, string> = {
  PRE_OPEN: `[분석 시점: 장 시작 전]
목적: 오늘 매수할 종목을 선별합니다.
판단 기준:
- 전일 기술 지표와 뉴스를 종합하여 오늘 상승 가능성을 평가하세요.
- 매수 신호가 있으면 진입 희망가(entryPrice)를 제시하세요. 시초가 대비 약간 낮은 가격이 이상적입니다.
- 미보유 종목의 신규 매수 기회를 탐색합니다.
- 이미 보유 중인 종목의 추가 매수(물타기) 여부도 판단하세요.`,

  POST_OPEN: `[분석 시점: 장 시작 30분 후]
목적: 장전 분석의 매수 판단을 시초가/초반 흐름 반영하여 최종 확정합니다.
판단 기준:
- 시초가와 초반 30분 거래량을 확인하세요.
- 장전 매수 신호가 있었다면, 시초가 이후 흐름이 판단을 지지하는지 검증하세요.
- 거래량이 평균 대비 2배 이상이면 변동성 주의.
- urgency를 IMMEDIATE 또는 WAIT_DIP으로 구체화하세요.`,

  PRE_CLOSE_1H: `[분석 시점: 장 마감 1시간 전]
목적: 보유 종목의 매도 여부를 판단합니다.
판단 기준:
- 보유 중인 종목의 당일 수익률과 기술 지표 변화를 평가하세요.
- 목표가 도달 종목은 이익실현(부분 또는 전량) 매도를 제안하세요.
- 손절가 이탈 종목은 즉시 매도를 권고하세요.
- 보유하지 않은 종목은 HOLD로 처리하세요.`,

  PRE_CLOSE_30M: `[분석 시점: 장 마감 30분 전]
목적: 매도 실행 최종 확인 및 당일 미체결 정리.
판단 기준:
- 장 마감 1시간 전 매도 판단이 여전히 유효한지 확인하세요.
- 당일 급등/급락 종목의 종가 마감 전략을 제시하세요.
- 오버나이트 리스크가 있는 종목은 매도를 고려하세요.
- suggestedRatio에 매도 비율을 명시하세요 (전량매도=100, 반매도=50 등).`,
};

/** 응답 JSON 스키마 */
const RESPONSE_SCHEMA = `{
  "signal": "BUY | SELL | HOLD",
  "confidence": 0~100,
  "targetPrice": 목표가(원) 또는 null,
  "stopLossPrice": 손절가(원) 또는 null,
  "entryPrice": 진입희망가(원) 또는 null,
  "suggestedRatio": 투자비중 0~100(%),
  "urgency": "IMMEDIATE | WAIT_DIP | GRADUAL | NO_RUSH",
  "reasoning": "종합 판단 근거 (한국어 2~4문장)",
  "keyFactors": ["핵심 판단 요인1", "핵심 판단 요인2", ...],
  "risks": ["리스크 요인1", "리스크 요인2", ...],
  "holdingPeriod": "DAY_TRADE | SWING | SHORT_TERM | MID_TERM"
}`;

// ─── 응답 파서 ──────────────────────────────────────────────

function parseDecisionResponse(response: string, input: StockAnalysisInput): TradeDecision {
  try {
    // thinking 모델은 JSON이 텍스트에 섞여 있을 수 있으므로 추출 시도
    let jsonStr = response.trim();

    // 순수 JSON 파싱 먼저 시도
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // JSON 블록 추출: 첫 번째 { 부터 마지막 } 까지
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
        parsed = JSON.parse(jsonStr);
      } else {
        throw new Error('No JSON found');
      }
    }

    const signal = (['BUY', 'SELL', 'HOLD'].includes(parsed.signal)) ? parsed.signal : 'HOLD';
    const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 50));

    // 규칙 강제: confidence < 60이면 HOLD
    const finalSignal = confidence < 60 ? 'HOLD' : signal;

    return {
      signal: finalSignal,
      confidence,
      targetPrice: parsed.targetPrice ? Number(parsed.targetPrice) : null,
      stopLossPrice: parsed.stopLossPrice ? Number(parsed.stopLossPrice) : null,
      entryPrice: parsed.entryPrice ? Number(parsed.entryPrice) : null,
      suggestedRatio: Math.min(100, Math.max(0, Number(parsed.suggestedRatio) || 0)),
      urgency: ['IMMEDIATE', 'WAIT_DIP', 'GRADUAL', 'NO_RUSH'].includes(parsed.urgency)
        ? parsed.urgency : 'NO_RUSH',
      reasoning: String(parsed.reasoning || '판단 근거 없음'),
      keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.map(String) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      holdingPeriod: ['DAY_TRADE', 'SWING', 'SHORT_TERM', 'MID_TERM'].includes(parsed.holdingPeriod)
        ? parsed.holdingPeriod : 'SHORT_TERM',
    };
  } catch {
    // JSON 파싱 실패 시 안전한 기본값
    return {
      signal: 'HOLD',
      confidence: 20,
      targetPrice: null,
      stopLossPrice: null,
      entryPrice: null,
      suggestedRatio: 0,
      urgency: 'NO_RUSH',
      reasoning: `LLM 응답 파싱 실패: ${response.slice(0, 200)}`,
      keyFactors: ['응답 형식 오류'],
      risks: ['LLM 응답을 신뢰할 수 없음'],
      holdingPeriod: 'SHORT_TERM',
    };
  }
}

// ─── 입력 데이터 생성 헬퍼 ──────────────────────────────────

/** 캔들 데이터에서 StockAnalysisInput 생성 */
export function buildAnalysisInput(
  ticker: string,
  name: string,
  market: 'KRX' | 'NYSE' | 'NASDAQ',
  candles: CandleData[],
  indicators: TechnicalIndicators,
  holding?: StockAnalysisInput['holding'],
  newsSummary?: string,
  marketContext?: string,
): StockAnalysisInput {
  const currentPrice = indicators.currentPrice;
  const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : currentPrice;
  const changePercent = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

  // 최근 5일 캔들
  const recent = candles.slice(-5).map((c, i, arr) => {
    const prev = i > 0 ? arr[i - 1].close : c.open;
    return {
      date: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      changePercent: prev > 0 ? ((c.close - prev) / prev) * 100 : 0,
    };
  });

  // 거래량 분석
  const volumes = candles.slice(-20).map(c => c.volume);
  const avgVolume20d = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const todayVolume = candles[candles.length - 1]?.volume ?? 0;
  const todayVsAvg = avgVolume20d > 0 ? todayVolume / avgVolume20d : 1;

  // 거래량 추세 (최근 5일 평균 vs 이전 5일 평균)
  const recentVols = candles.slice(-5).map(c => c.volume);
  const prevVols = candles.slice(-10, -5).map(c => c.volume);
  const recentAvg = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
  const prevAvg = prevVols.length > 0 ? prevVols.reduce((a, b) => a + b, 0) / prevVols.length : 0;
  let volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE' = 'STABLE';
  if (prevAvg > 0) {
    const ratio = recentAvg / prevAvg;
    if (ratio > 1.3) volumeTrend = 'INCREASING';
    else if (ratio < 0.7) volumeTrend = 'DECREASING';
  }

  return {
    ticker,
    name,
    market,
    currentPrice,
    previousClose: prevClose,
    changePercent: Math.round(changePercent * 100) / 100,
    holding,
    indicators: {
      rsi14: indicators.rsi14,
      sma5: indicators.sma5,
      sma20: indicators.sma20,
      sma60: indicators.sma60,
      sma120: indicators.sma120,
      ema12: indicators.ema12,
      ema26: indicators.ema26,
      macd: indicators.macd,
      macdSignal: indicators.macdSignal,
      macdHistogram: indicators.macdHistogram,
      bollingerUpper: indicators.bollingerUpper,
      bollingerMiddle: indicators.bollingerMiddle,
      bollingerLower: indicators.bollingerLower,
      technicalSignal: indicators.signal,
      technicalReasons: indicators.signalReasons,
    },
    recentCandles: recent,
    volumeAnalysis: {
      avgVolume20d: Math.round(avgVolume20d),
      todayVsAvg: Math.round(todayVsAvg * 100) / 100,
      volumeTrend,
    },
    newsSummary,
    marketContext,
  };
}
