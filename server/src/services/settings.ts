import fs from 'fs';
import os from 'os';
import path from 'path';

// Persistent location: prefer STOCK_MANAGER_DATA env var, then ~/.stock-manager/
// (NEVER fall back to a path inside the package — would be wiped on brew upgrade)
const DATA_DIR = process.env.STOCK_MANAGER_DATA || path.join(os.homedir(), '.stock-manager');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

/**
 * Snapshot externally-provided environment variables AT MODULE LOAD TIME,
 * before any internal code mutates process.env. Used to decide whether
 * secrets should be stripped from the on-disk JSON.
 *
 * If the user provided keys via OS env vars at startup, they are stored here.
 * If they only entered keys via the UI, ENV_SECRETS will be undefined and
 * keys WILL be persisted to settings.json (so they survive restart).
 */
const ENV_SECRETS: Readonly<{
  kisAppKey: string | undefined;
  kisAppSecret: string | undefined;
  dartApiKey: string | undefined;
}> = {
  kisAppKey: process.env.KIS_APP_KEY,
  kisAppSecret: process.env.KIS_APP_SECRET,
  dartApiKey: process.env.DART_API_KEY,
};

export interface MarketScheduleConfig {
  enabled: boolean;
  preOpen: boolean;
  postOpen: boolean;
  preClose1h: boolean;
  preClose30m: boolean;
}

export interface AppSettings {
  // KIS API
  kisAppKey: string;
  kisAppSecret: string;
  kisAccountNo: string;
  kisAccountProductCode: string;
  kisVirtual: boolean;
  mcpEnabled: boolean;

  // Ollama (로컬 LLM)
  ollamaUrl: string;
  ollamaModel: string;
  ollamaEnabled: boolean;

  // DART (금융감독원 공시)
  dartApiKey: string;
  dartEnabled: boolean;

  // AI 분석 옵션
  investmentStyle: 'balanced' | 'value' | 'growth' | 'momentum';
  debateMode: boolean;
  stopLossPercent: number;

  // 자동매매
  autoTradeEnabled: boolean;
  autoTradeMaxInvestment: number;    // 총 최대 투자금액
  autoTradeMaxPerStock: number;      // 종목당 최대 투자금액
  autoTradeMaxDailyTrades: number;   // 일일 최대 거래 횟수

  // 시장별 스케줄
  scheduleKrx: MarketScheduleConfig;
  scheduleNyse: MarketScheduleConfig;

  // 자동매매 임계값 (조정 가능)
  autoTradeScoreThreshold: number;    // 자동매매 승격 점수 (기본 100)
  priceChangeThreshold: number;       // 연속모니터 가격변동 임계값 % (기본 2)

  // NAS 데이터 동기화
  nasSyncEnabled: boolean;
  nasSyncPath: string;          // 로컬 마운트 경로 (예: /Volumes/stock-manager)
  nasSyncTime: string;          // cron 시간
  deviceId: string;
  nasHost: string;              // NAS 주소 (예: shartith.iptime.org)
  nasShare: string;             // 공유폴더명 (예: stock-manager)
  nasUsername: string;          // NAS 접속 ID
  nasPassword: string;          // NAS 접속 비밀번호
  nasAutoMount: boolean;        // 시작 시 자동 마운트

  // 포트폴리오 운영
  portfolioMaxHoldings: number;
  portfolioMaxPerStockPercent: number;
  portfolioMaxSectorPercent: number;
  portfolioRebalanceEnabled: boolean;
  portfolioMinCashPercent: number;

  // 매매 원칙
  tradingRulesEnabled: boolean;
  tradingRulesStrictMode: boolean;
  gapThresholdPercent: number;
  volumeSurgeRatio: number;
  lowVolumeRatio: number;
  sidewaysAtrPercent: number;

  // 매도 규칙 (hard rules — LLM 불필요)
  sellRulesEnabled: boolean;
  targetProfitRate: number;      // +N% → 전량 매도
  hardStopLossRate: number;      // -N% → 전량 매도
  trailingStopRate: number;      // 고점 대비 -N% → 전량 매도
  maxHoldMinutes: number;        // N분 초과 → 전량 매도

  // 포지션 사이징
  positionMaxRatio: number;      // 전체 예산의 N%
  positionMinCashRatio: number;  // 현금 N% 미만이면 매수 금지
  positionMaxPositions: number;  // 최대 동시 보유 종목 수

  // 동적 스크리닝
  dynamicScreeningEnabled: boolean;
  screeningVolumeRatioMin: number;  // RISING: 5일 평균 거래량의 N배
  screeningMinMarketCap: number;    // FLAT: 시가총액 N억 이상
}

const DEFAULT_SETTINGS: AppSettings = {
  kisAppKey: '',
  kisAppSecret: '',
  kisAccountNo: '',
  kisAccountProductCode: '01',
  kisVirtual: true,
  mcpEnabled: false,

  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3:4b',
  ollamaEnabled: false,

  dartApiKey: '',
  dartEnabled: false,

  investmentStyle: 'balanced',
  debateMode: false,
  stopLossPercent: 3,

  autoTradeEnabled: false,
  autoTradeMaxInvestment: 10000000,
  autoTradeMaxPerStock: 2000000,
  autoTradeMaxDailyTrades: 10,

  scheduleKrx: { enabled: false, preOpen: true, postOpen: true, preClose1h: true, preClose30m: true },
  scheduleNyse: { enabled: false, preOpen: true, postOpen: true, preClose1h: true, preClose30m: true },

  autoTradeScoreThreshold: 100,
  priceChangeThreshold: 2,

  nasSyncEnabled: false,
  nasSyncPath: '/Volumes/stock-manager',
  nasSyncTime: '0 20 * * *',
  deviceId: '',
  nasHost: '',
  nasShare: 'stock-manager',
  nasUsername: '',
  nasPassword: '',
  nasAutoMount: true,

  portfolioMaxHoldings: 10,
  portfolioMaxPerStockPercent: 20,
  portfolioMaxSectorPercent: 40,
  portfolioRebalanceEnabled: false,
  portfolioMinCashPercent: 10,

  tradingRulesEnabled: true,
  tradingRulesStrictMode: false,
  gapThresholdPercent: 3,
  volumeSurgeRatio: 1.5,
  lowVolumeRatio: 0.7,
  sidewaysAtrPercent: 1.0,

  sellRulesEnabled: true,
  targetProfitRate: 3.0,
  hardStopLossRate: 2.0,
  trailingStopRate: 1.5,
  maxHoldMinutes: 60,

  positionMaxRatio: 25,
  positionMinCashRatio: 20,
  positionMaxPositions: 3,

  dynamicScreeningEnabled: true,
  screeningVolumeRatioMin: 1.5,
  screeningMinMarketCap: 500,
};

let _cache: AppSettings | null = null;

/**
 * Legacy fields that were once stored in settings.json but are no longer used
 * by any code path. They are stripped on load and on save so the file
 * eventually self-cleans without forcing a manual migration.
 *
 * v4.5.0 introduced externalAi* fields for an external AI provider option,
 * but the project pivoted to local-only Ollama. Those fields became dead
 * config and a needless source of leaked secrets in NAS sync exports.
 */
const LEGACY_FIELDS = [
  'externalAiApiKey',
  'externalAiProvider',
  'externalAiModel',
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
      const parsed = stripLegacyFields(JSON.parse(raw));
      _cache = { ...DEFAULT_SETTINGS, ...parsed } as AppSettings;
    } catch {
      _cache = { ...DEFAULT_SETTINGS };
    }
  } else {
    _cache = { ...DEFAULT_SETTINGS };
  }

  // External env vars (set BEFORE this module loaded) take priority over file values
  if (ENV_SECRETS.kisAppKey) _cache!.kisAppKey = ENV_SECRETS.kisAppKey;
  if (ENV_SECRETS.kisAppSecret) _cache!.kisAppSecret = ENV_SECRETS.kisAppSecret;
  if (ENV_SECRETS.dartApiKey) _cache!.dartApiKey = ENV_SECRETS.dartApiKey;

  // Sync to process.env so other modules (e.g. KIS API client) can read them.
  // This does NOT affect strip logic in saveSettings — that uses ENV_SECRETS snapshot.
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

  // Strip secrets ONLY if they were originally provided via external env vars.
  // Keys entered through the UI MUST be persisted to settings.json so they
  // survive process restart and brew upgrade.
  const { kisAppKey, kisAppSecret, dartApiKey, ...safeSettings } = _cache;
  const toSave = {
    ...safeSettings,
    ...(ENV_SECRETS.kisAppKey ? {} : { kisAppKey }),
    ...(ENV_SECRETS.kisAppSecret ? {} : { kisAppSecret }),
    ...(ENV_SECRETS.dartApiKey ? {} : { dartApiKey }),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toSave, null, 2), 'utf-8');

  // Sync to process.env for runtime use by other modules
  if (_cache.kisAppKey) process.env.KIS_APP_KEY = _cache.kisAppKey;
  if (_cache.kisAppSecret) process.env.KIS_APP_SECRET = _cache.kisAppSecret;
  process.env.KIS_VIRTUAL = _cache.kisVirtual ? 'true' : 'false';
}

/** Test-only: clear cache so tests can re-initialize. Production code should not call this. */
export function _clearSettingsCache(): void {
  _cache = null;
}
