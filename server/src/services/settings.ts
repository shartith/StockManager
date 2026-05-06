/**
 * 설정 관리 (v5.0.0 슬림화).
 *
 * 제거된 필드: investmentStyle, debateMode, stopLossPercent (구 PRE_OPEN 분석용),
 *            autoTradeScoreThreshold, priceChangeThreshold, portfolioMaxHoldings,
 *            portfolioMaxPerStockPercent, portfolioMaxSectorPercent,
 *            portfolioRebalanceEnabled, portfolioMinCashPercent,
 *            tradingRulesEnabled, tradingRulesStrictMode, gapThresholdPercent,
 *            volumeSurgeRatio, lowVolumeRatio, sidewaysAtrPercent, maxHoldMinutes,
 *            dynamicScreeningEnabled, screeningVolumeRatioMin, screeningMinMarketCap,
 *            paperTradingEnabled, paperTradeAmount, backtestMinTradesForSave,
 *            roiTable, protections, presets.
 *
 * 추가: sidewaysMinutes, sidewaysRangePercent, lossMinutes (Rule 8/9 임계값).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = process.env.STOCK_MANAGER_DATA || path.join(os.homedir(), '.stock-manager');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const ENV_SECRETS: Readonly<{
  kisAppKey: string | undefined;
  kisAppSecret: string | undefined;
  dartApiKey: string | undefined;
  llmApiKey: string | undefined;
}> = {
  kisAppKey: process.env.KIS_APP_KEY,
  kisAppSecret: process.env.KIS_APP_SECRET,
  dartApiKey: process.env.DART_API_KEY,
  llmApiKey: process.env.LLM_API_KEY,
};

export interface MarketScheduleConfig {
  enabled: boolean;
}

export interface AppSettings {
  // KIS API
  kisAppKey: string;
  kisAppSecret: string;
  kisAccountNo: string;
  kisAccountProductCode: string;
  kisVirtual: boolean;
  mcpEnabled: boolean;

  // 외부 OpenAI 호환 LLM (뉴스 요약 / Rule 12 용)
  llmProvider: 'ollama' | 'openai';
  llmUrl: string;
  llmModel: string;
  llmEnabled: boolean;
  llmApiKey: string;
  llmFallbackUrl?: string;
  llmFallbackModel?: string;
  llmFallbackApiKey?: string;

  // DART (금융감독원 공시)
  dartApiKey: string;
  dartEnabled: boolean;

  // 자동매매 ON/OFF + 한도
  autoTradeEnabled: boolean;
  autoTradeMaxInvestment: number;
  autoTradeMaxPerStock: number;
  autoTradeMaxDailyTrades: number;

  // KRX 매매 스케줄
  scheduleKrx: MarketScheduleConfig;

  // 매도 규칙 (sellRules.ts)
  sellRulesEnabled: boolean;
  targetProfitRate: number;          // Rule 7-1: +N% → 전량 매도 (default 3.0)
  hardStopLossRate: number;          // Rule 6: -N% → 전량 매도 (default 2.0)
  trailingStopRate: number;          // Rule 7-2: 활성 후 고점 대비 -N% (default 1.5)
  trailingActivatePercent: number;   // 트레일링 활성 임계값 (default 3.0)
  sidewaysMinutes: number;           // Rule 7+8: N분 정체 → 매도 (default 60)
  lossMinutes: number;               // Rule 9: N분 손실 유지 → 강제 손절 (default 60)
  profitThresholdPercent: number;    // "수익 상태" 정의 — 수수료 보전 (default 0.5)

  // 포지션 사이징 (Rule 4)
  positionMaxPositions: number;      // 최대 동시 보유 종목 수 (default 5)

  // EOD (Rule 10, 11)
  eodProfitTakePercent: number;      // 15:00 익절 임계값 (default 3.0)

  // 매수 게이트 (HIGH 보강)
  entryGainPercent: number;          // 시초가 대비 N% 상승 → 매수 트리거 (default 1.0)
  marketBrakeEnabled: boolean;       // KOSPI 폭락 시 매수 차단 활성 (default true)
  marketBrakeKospiPercent: number;   // KOSPI -N% 이하면 매수 차단 (default 2.0)
  marketBrakeVixLevel: number;       // VIX ≥ N이면 매수 차단 (default 30)
  gapUpMaxPercent: number;           // 자동목록에서 갭상승 ≥N% 종목 제외 (default 3.0)
  reEntryCooldownMinutes: number;    // 매도 후 N분 매수 차단 (default 30)

  // NAS 동기화
  nasSyncEnabled: boolean;
  nasSyncPath: string;
  nasSyncTime: string;
  nasImportEnabled?: boolean;
  deviceId: string;
  nasHost: string;
  nasShare: string;
  nasUsername: string;
  nasPassword: string;
  nasAutoMount: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  kisAppKey: '',
  kisAppSecret: '',
  kisAccountNo: '',
  kisAccountProductCode: '01',
  kisVirtual: true,
  mcpEnabled: false,

  llmProvider: 'openai',
  llmUrl: 'https://ai.unids.kr/v1',
  llmModel: '',
  llmEnabled: true,
  llmApiKey: '',

  dartApiKey: '',
  dartEnabled: false,

  autoTradeEnabled: false,
  autoTradeMaxInvestment: 10_000_000,
  autoTradeMaxPerStock: 2_000_000,
  autoTradeMaxDailyTrades: 10,

  scheduleKrx: { enabled: false },

  sellRulesEnabled: true,
  targetProfitRate: 3.0,
  hardStopLossRate: 2.0,
  trailingStopRate: 1.5,
  trailingActivatePercent: 3.0,
  sidewaysMinutes: 60,
  lossMinutes: 60,
  profitThresholdPercent: 0.5,

  positionMaxPositions: 5,

  eodProfitTakePercent: 3.0,

  entryGainPercent: 1.0,
  marketBrakeEnabled: true,
  marketBrakeKospiPercent: 2.0,
  marketBrakeVixLevel: 30,
  gapUpMaxPercent: 3.0,
  reEntryCooldownMinutes: 30,

  nasSyncEnabled: false,
  nasSyncPath: '/Volumes/stock-manager',
  nasSyncTime: '0 20 * * *',
  deviceId: '',
  nasHost: '',
  nasShare: 'stock-manager',
  nasUsername: '',
  nasPassword: '',
  nasAutoMount: true,
};

let _cache: AppSettings | null = null;

/** v4.x 시절의 사용하지 않는 키. 로드 시 strip — 파일 자가 정리. */
const LEGACY_FIELDS = [
  // v4.x 외부 AI / Ollama / MLX 마이그레이션 잔재
  'externalAiApiKey', 'externalAiProvider', 'externalAiModel',
  'ollamaUrl', 'ollamaModel', 'ollamaEnabled',
  'mlxUrl', 'mlxModel', 'mlxEnabled',
  // v5.0.0에서 제거한 필드
  'investmentStyle', 'debateMode', 'stopLossPercent',
  'autoTradeScoreThreshold', 'priceChangeThreshold',
  'portfolioMaxHoldings', 'portfolioMaxPerStockPercent', 'portfolioMaxSectorPercent',
  'portfolioRebalanceEnabled', 'portfolioMinCashPercent',
  'tradingRulesEnabled', 'tradingRulesStrictMode', 'gapThresholdPercent',
  'volumeSurgeRatio', 'lowVolumeRatio', 'sidewaysAtrPercent',
  'maxHoldMinutes', 'roiTable', 'protections', 'preset',
  'dynamicScreeningEnabled', 'screeningVolumeRatioMin', 'screeningMinMarketCap',
  'paperTradingEnabled', 'paperTradeAmount', 'backtestMinTradesForSave',
  'scheduleNyse',
  // v5.1.0에서 제거한 필드
  'positionMaxRatio', 'positionMinCashRatio', 'sidewaysRangePercent',
] as const;

function stripLegacyFields(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if ((LEGACY_FIELDS as readonly string[]).includes(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function getSettings(): AppSettings {
  if (_cache) return _cache;

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      const rawParsed = JSON.parse(raw) as Record<string, unknown>;
      const parsed = stripLegacyFields(rawParsed);
      _cache = { ...DEFAULT_SETTINGS, ...parsed } as AppSettings;
    } catch {
      _cache = { ...DEFAULT_SETTINGS };
    }
  } else {
    _cache = { ...DEFAULT_SETTINGS };
  }

  if (ENV_SECRETS.kisAppKey) _cache!.kisAppKey = ENV_SECRETS.kisAppKey;
  if (ENV_SECRETS.kisAppSecret) _cache!.kisAppSecret = ENV_SECRETS.kisAppSecret;
  if (ENV_SECRETS.dartApiKey) _cache!.dartApiKey = ENV_SECRETS.dartApiKey;
  if (ENV_SECRETS.llmApiKey) _cache!.llmApiKey = ENV_SECRETS.llmApiKey;

  if (_cache!.kisAppKey) process.env.KIS_APP_KEY = _cache!.kisAppKey;
  if (_cache!.kisAppSecret) process.env.KIS_APP_SECRET = _cache!.kisAppSecret;
  process.env.KIS_VIRTUAL = _cache!.kisVirtual ? 'true' : 'false';

  return _cache!;
}

export function saveSettings(partial: Partial<AppSettings>) {
  const current = getSettings();
  _cache = { ...current, ...partial };

  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // env로 주입된 secret은 파일에 저장하지 않음
  const { kisAppKey, kisAppSecret, dartApiKey, llmApiKey, ...safeSettings } = _cache;
  const toSave = {
    ...safeSettings,
    ...(ENV_SECRETS.kisAppKey ? {} : { kisAppKey }),
    ...(ENV_SECRETS.kisAppSecret ? {} : { kisAppSecret }),
    ...(ENV_SECRETS.dartApiKey ? {} : { dartApiKey }),
    ...(ENV_SECRETS.llmApiKey ? {} : { llmApiKey }),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toSave, null, 2), 'utf-8');

  if (_cache.kisAppKey) process.env.KIS_APP_KEY = _cache.kisAppKey;
  if (_cache.kisAppSecret) process.env.KIS_APP_SECRET = _cache.kisAppSecret;
  process.env.KIS_VIRTUAL = _cache.kisVirtual ? 'true' : 'false';
}

export function _clearSettingsCache(): void {
  _cache = null;
}
