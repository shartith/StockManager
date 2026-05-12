/**
 * 설정 관리 (v5.2.0 추가 슬림화).
 *
 * v5.2 제거:
 *   - autoTradeMaxInvestment, autoTradeMaxPerStock, autoTradeMaxDailyTrades
 *     → KIS 잔고 + positionMaxPositions로 자동 산정.
 *   - nasSyncEnabled, nasSyncPath, nasSyncTime, nasImportEnabled,
 *     nasHost, nasShare, nasUsername, nasPassword, nasAutoMount, deviceId
 *     → NAS sync 기능 전체 제거.
 *
 * 자동매매는 ON/OFF 토글 하나 + KRX 스케줄 토글 하나만 노출.
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

  // 외부 OpenAI 호환 LLM (Rule 12 / 뉴스 요약 / systemEvent 조언)
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

  // 자동매매 (ON/OFF만)
  autoTradeEnabled: boolean;

  // 전략 모드 (v5.5.0)
  //   'top10'  : 시총 Top 10 추종 (단순)
  //   'legacy' : 12-Rule 매매 엔진 (섹터 로테이션)
  strategyMode: 'top10' | 'legacy';

  // KRX 스케줄
  scheduleKrx: MarketScheduleConfig;

  // 매도 규칙
  sellRulesEnabled: boolean;
  targetProfitRate: number;
  hardStopLossRate: number;
  trailingStopRate: number;
  trailingActivatePercent: number;
  sidewaysMinutes: number;
  lossMinutes: number;
  profitThresholdPercent: number;

  // 포지션 사이징 (Rule 4)
  positionMaxPositions: number;

  // EOD
  eodProfitTakePercent: number;

  // 매수 게이트
  entryGainPercent: number;
  marketBrakeEnabled: boolean;
  marketBrakeKospiPercent: number;
  marketBrakeVixLevel: number;
  gapUpMaxPercent: number;
  reEntryCooldownMinutes: number;
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

  strategyMode: 'top10',

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
};

let _cache: AppSettings | null = null;

const LEGACY_FIELDS = [
  // v4.x 외부 AI / Ollama / MLX 잔재
  'externalAiApiKey', 'externalAiProvider', 'externalAiModel',
  'ollamaUrl', 'ollamaModel', 'ollamaEnabled',
  'mlxUrl', 'mlxModel', 'mlxEnabled',
  // v5.0.0에서 제거
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
  // v5.1.0에서 제거
  'positionMaxRatio', 'positionMinCashRatio', 'sidewaysRangePercent',
  // v5.2.0에서 제거
  'autoTradeMaxInvestment', 'autoTradeMaxPerStock', 'autoTradeMaxDailyTrades',
  'nasSyncEnabled', 'nasSyncPath', 'nasSyncTime', 'nasImportEnabled',
  'nasHost', 'nasShare', 'nasUsername', 'nasPassword', 'nasAutoMount', 'deviceId',
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
