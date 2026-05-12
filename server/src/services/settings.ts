/**
 * 설정 관리 (v5.6.0 라이트 모드).
 *
 * 노출 필드: KIS 인증 + 자동매매 ON/OFF + KRX 스케줄 + 시장 브레이크.
 *
 * v5.6 제거:
 *   LLM (llmProvider, llmUrl, llmModel, llmEnabled, llmApiKey, llmFallbackUrl 등)
 *   DART (dartApiKey, dartEnabled)
 *   sellRules 11종 (targetProfitRate, hardStopLossRate, trailingStopRate 등)
 *   매수 게이트 (entryGainPercent, gapUpMaxPercent, reEntryCooldownMinutes)
 *   포지션 (positionMaxPositions — Top10 고정 10)
 *   EOD (eodProfitTakePercent)
 *   strategyMode (top10 only)
 *   mcpEnabled
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = process.env.STOCK_MANAGER_DATA || path.join(os.homedir(), '.stock-manager');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const ENV_SECRETS: Readonly<{
  kisAppKey: string | undefined;
  kisAppSecret: string | undefined;
}> = {
  kisAppKey: process.env.KIS_APP_KEY,
  kisAppSecret: process.env.KIS_APP_SECRET,
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

  // 자동매매 (ON/OFF만)
  autoTradeEnabled: boolean;

  // KRX 스케줄
  scheduleKrx: MarketScheduleConfig;

  // 시장 브레이크 (안전망)
  marketBrakeEnabled: boolean;
  marketBrakeKospiPercent: number;
  marketBrakeVixLevel: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  kisAppKey: '',
  kisAppSecret: '',
  kisAccountNo: '',
  kisAccountProductCode: '01',
  kisVirtual: true,

  autoTradeEnabled: false,

  scheduleKrx: { enabled: false },

  marketBrakeEnabled: true,
  marketBrakeKospiPercent: 2.0,
  marketBrakeVixLevel: 30,
};

let _cache: AppSettings | null = null;

// 과거 버전 잔재 필드 — 로드 시 자동 제거 (이전 settings.json 와의 호환)
const LEGACY_FIELDS = [
  // v4.x
  'externalAiApiKey', 'externalAiProvider', 'externalAiModel',
  'ollamaUrl', 'ollamaModel', 'ollamaEnabled',
  'mlxUrl', 'mlxModel', 'mlxEnabled',
  // v5.0~5.2
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
  'positionMaxRatio', 'positionMinCashRatio', 'sidewaysRangePercent',
  'autoTradeMaxInvestment', 'autoTradeMaxPerStock', 'autoTradeMaxDailyTrades',
  'nasSyncEnabled', 'nasSyncPath', 'nasSyncTime', 'nasImportEnabled',
  'nasHost', 'nasShare', 'nasUsername', 'nasPassword', 'nasAutoMount', 'deviceId',
  // v5.6.0 라이트 모드에서 제거
  'mcpEnabled',
  'llmProvider', 'llmUrl', 'llmModel', 'llmEnabled', 'llmApiKey',
  'llmFallbackUrl', 'llmFallbackModel', 'llmFallbackApiKey',
  'dartApiKey', 'dartEnabled',
  'sellRulesEnabled', 'targetProfitRate', 'hardStopLossRate',
  'trailingStopRate', 'trailingActivatePercent',
  'sidewaysMinutes', 'lossMinutes', 'profitThresholdPercent',
  'positionMaxPositions',
  'eodProfitTakePercent',
  'entryGainPercent', 'gapUpMaxPercent', 'reEntryCooldownMinutes',
  'strategyMode',
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

  const { kisAppKey, kisAppSecret, ...safeSettings } = _cache;
  const toSave = {
    ...safeSettings,
    ...(ENV_SECRETS.kisAppKey ? {} : { kisAppKey }),
    ...(ENV_SECRETS.kisAppSecret ? {} : { kisAppSecret }),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toSave, null, 2), 'utf-8');

  if (_cache.kisAppKey) process.env.KIS_APP_KEY = _cache.kisAppKey;
  if (_cache.kisAppSecret) process.env.KIS_APP_SECRET = _cache.kisAppSecret;
  process.env.KIS_VIRTUAL = _cache.kisVirtual ? 'true' : 'false';
}

export function _clearSettingsCache(): void {
  _cache = null;
}
