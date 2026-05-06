/**
 * LLM 클라이언트 (v5.0.0 슬림화).
 *
 * v5.0 이전: 실시간 매매 판단 (getTradeDecision/buildAnalysisInput) 거대 시스템.
 * v5.0+: callLlm + checkLlmStatus + Rule 12 전용 findLowPositionBreakouts 만 유지.
 *
 * 매매 판단은 dailyStrategy.ts의 단순 룰 기반으로 이동했음.
 * LLM은 (1) 뉴스 요약 (2) systemEvent AI 조언 (3) Rule 12 저평가 횡보 후보 추천 — 3가지 용도만.
 */

import { getSettings } from './settings';
import { KRX_TOP_STOCKS } from '../config/marketStocks';
import logger from '../logger';

// ─── LLM 상태 ───────────────────────────────────────────────

export async function checkLlmStatus(): Promise<{ connected: boolean; models: string[] }> {
  const settings = getSettings();
  try {
    const headers: Record<string, string> = {};
    if (settings.llmApiKey) headers['Authorization'] = `Bearer ${settings.llmApiKey}`;
    const res = await fetch(`${settings.llmUrl}/models`, { headers });
    if (!res.ok) return { connected: false, models: [] };
    const data: any = await res.json();
    const models = (data.data || []).map((m: any) => m.id).filter(Boolean);
    return { connected: true, models };
  } catch {
    return { connected: false, models: [] };
  }
}

let _resolvedModel = '';
async function resolveModel(settings: ReturnType<typeof getSettings>): Promise<string> {
  if (settings.llmModel) return settings.llmModel;
  if (_resolvedModel) return _resolvedModel;

  const status = await checkLlmStatus();
  if (status.models.length > 0) {
    _resolvedModel = status.models[0];
    logger.info({ model: _resolvedModel }, 'LLM 모델 자동 감지');
    return _resolvedModel;
  }
  throw new Error('LLM 서버에 사용 가능한 모델이 없습니다.');
}

// ─── 호출 안정성 (timeout / mutex / retry) ──────────────────

const LLM_TIMEOUT_MS = 120_000;
const LLM_RETRY_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 1_000;

let llmQueue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('fetch failed')
    || msg.includes('econnrefused')
    || msg.includes('econnreset')
    || msg.includes('socket hang up')
    || msg.includes('aborted')
    || msg.includes('etimedout');
}

async function callLlmRaw(
  model: string,
  url: string,
  prompt: string,
  system: string,
  numPredict: number,
  apiKey: string = '',
  jsonMode: boolean = false,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const body: any = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: numPredict,
      stream: false,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM 요청 실패 (HTTP ${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callLlm(
  model: string,
  url: string,
  prompt: string,
  system: string,
  numPredict: number = 1024,
  apiKey: string = '',
): Promise<string> {
  let effectiveModel = model;
  if (!effectiveModel) {
    const settings = getSettings();
    effectiveModel = await resolveModel(settings);
  }

  const task = llmQueue.catch(() => undefined).then(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < LLM_RETRY_ATTEMPTS; attempt++) {
      try {
        return await callLlmRaw(effectiveModel, url, prompt, system, numPredict, apiKey);
      } catch (err) {
        lastErr = err;
        if (attempt === LLM_RETRY_ATTEMPTS - 1) break;
        if (!isRetriableError(err)) break;
        const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.debug({ err: (err as Error).message, attempt: attempt + 1, delay }, 'LLM call retry');
        await sleep(delay);
      }
    }

    const settings = getSettings();
    const fallbackUrl = (settings as any).llmFallbackUrl;
    if (fallbackUrl && fallbackUrl !== url) {
      const fallbackModel = (settings as any).llmFallbackModel || effectiveModel;
      const fallbackApiKey = (settings as any).llmFallbackApiKey || '';
      logger.warn({ primary: url, fallback: fallbackUrl }, 'LLM fallback 시도');
      try {
        return await callLlmRaw(fallbackModel, fallbackUrl, prompt, system, numPredict, fallbackApiKey);
      } catch (fallbackErr) {
        logger.error({ err: (fallbackErr as Error).message }, 'LLM fallback 실패');
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('LLM 호출 실패');
  });

  llmQueue = task.catch(() => undefined);
  return task as Promise<string>;
}

// ─── Rule 12: 저평가 장기 횡보 → 급등 예상 후보 ────────────

export interface BreakoutCandidate {
  ticker: string;
  name: string;
  sector: string;
  reason: string;
}

/**
 * 상위 상승 카테고리에 속하지만 저평가 + 장기 횡보 중인 종목을 LLM에게 추천받는다.
 * Universe: KRX_TOP_STOCKS (config) — 약 80개.
 * 호출 빈도: 1일 1회 (주말 학습 대신 일별 짧은 호출).
 */
export async function findLowPositionBreakouts(
  strongSectors: string[],
  maxCandidates: number = 5,
): Promise<BreakoutCandidate[]> {
  const settings = getSettings();
  if (!settings.llmEnabled) return [];

  // 강세 섹터에 속하는 종목 + 인접 섹터 종목 후보 풀
  const pool = KRX_TOP_STOCKS.filter(s =>
    strongSectors.length === 0 || strongSectors.some(ss => s.sector.includes(ss) || ss.includes(s.sector))
  );
  if (pool.length === 0) return [];

  const universe = pool.map(s => `${s.ticker} ${s.name} (${s.sector})`).join('\n');

  const system = `당신은 한국 주식 가치투자 분석가입니다. 다음 후보 풀에서 "저평가 + 장기 횡보 → 급등 예상" 종목을 ${maxCandidates}개 이하로 선별합니다.
선별 기준:
- 상위 상승 카테고리에 속하는 분야이지만 시세는 낮은 포지션에서 장기간 횡보
- 너무 터무니없는 잡주는 제외
- 펀더멘털이 받쳐주거나 재료/모멘텀이 잠재해 있어 언젠가 큰 상승 가능성

출력은 valid JSON 배열만. 형식: [{"ticker":"005930","name":"삼성전자","sector":"AI/반도체","reason":"한 줄 사유"}]
후보가 없으면 빈 배열 [].`;

  const prompt = `상위 상승 카테고리: ${strongSectors.join(', ') || '(전체)'}

후보 풀 (KRX TOP):
${universe}

저평가 + 장기 횡보 + 급등 예상 종목 ${maxCandidates}개 이하 추천. JSON 배열만 출력.`;

  try {
    const raw = await callLlm(settings.llmModel, settings.llmUrl, prompt, system, 800, settings.llmApiKey);
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    const valid: BreakoutCandidate[] = [];
    for (const item of parsed) {
      if (item && typeof item.ticker === 'string' && typeof item.name === 'string') {
        valid.push({
          ticker: String(item.ticker).trim(),
          name: String(item.name).trim(),
          sector: String(item.sector || '').trim(),
          reason: String(item.reason || '').slice(0, 200),
        });
      }
      if (valid.length >= maxCandidates) break;
    }
    logger.info({ count: valid.length, strongSectors }, 'breakout candidates from LLM');
    return valid;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'findLowPositionBreakouts failed');
    return [];
  }
}
