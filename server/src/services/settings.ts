import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.STOCK_MANAGER_DATA || path.join(__dirname, '../../../data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

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

  // 매매 원칙
  tradingRulesEnabled: boolean;
  tradingRulesStrictMode: boolean;
  gapThresholdPercent: number;
  volumeSurgeRatio: number;
  lowVolumeRatio: number;
  sidewaysAtrPercent: number;
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

  tradingRulesEnabled: true,
  tradingRulesStrictMode: false,
  gapThresholdPercent: 3,
  volumeSurgeRatio: 1.5,
  lowVolumeRatio: 0.7,
  sidewaysAtrPercent: 1.0,
};

let _cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (_cache) return _cache;

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      _cache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      _cache = { ...DEFAULT_SETTINGS };
    }
  } else {
    _cache = { ...DEFAULT_SETTINGS };
  }

  // Environment variable priority for secrets
  if (process.env.KIS_APP_KEY) _cache!.kisAppKey = process.env.KIS_APP_KEY;
  if (process.env.KIS_APP_SECRET) _cache!.kisAppSecret = process.env.KIS_APP_SECRET;
  if (process.env.DART_API_KEY) _cache!.dartApiKey = process.env.DART_API_KEY;

  // 환경변수로도 동기화
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

  // Strip secrets before writing to JSON if set via env vars
  const { kisAppKey, kisAppSecret, dartApiKey, ...safeSettings } = _cache;
  const toSave = {
    ...safeSettings,
    ...(process.env.KIS_APP_KEY ? {} : { kisAppKey }),
    ...(process.env.KIS_APP_SECRET ? {} : { kisAppSecret }),
    ...(process.env.DART_API_KEY ? {} : { dartApiKey }),
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toSave, null, 2), 'utf-8');

  // 환경변수 동기화
  if (_cache.kisAppKey) process.env.KIS_APP_KEY = _cache.kisAppKey;
  if (_cache.kisAppSecret) process.env.KIS_APP_SECRET = _cache.kisAppSecret;
  process.env.KIS_VIRTUAL = _cache.kisVirtual ? 'true' : 'false';
}
