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
  llmApiKey: string | undefined;
}> = {
  kisAppKey: process.env.KIS_APP_KEY,
  kisAppSecret: process.env.KIS_APP_SECRET,
  dartApiKey: process.env.DART_API_KEY,
  llmApiKey: process.env.LLM_API_KEY,
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

  // 외부 OpenAI 호환 LLM (v4.13.0: Ollama / OpenAI 호환 원격 서버 지원)
  // llmUrl 은 /v1 을 포함하는 full base URL (OpenAI 관례).
  llmProvider: 'ollama' | 'openai'; // UI 표시용 프리셋 선택자
  llmUrl: string;           // 기본 https://ai.unids.kr/v1
  llmModel: string;         // 빈 값 = 사용자 선택
  llmEnabled: boolean;
  llmApiKey: string;        // Bearer 토큰 (OpenAI 호환 공개 API용). Ollama는 빈 값.

  // v4.18.0: LLM provider 자동 스위치 — primary 3회 retry 실패 시 fallback 1회 시도.
  // 예: primary=ai.unids.kr (외부), fallback=http://localhost:11434/v1 (로컬 Ollama)
  // undefined이면 fallback 미사용 (기존 동작 유지).
  llmFallbackUrl?: string;
  llmFallbackModel?: string;
  llmFallbackApiKey?: string;

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

  // v4.19.0: 양방향 NAS sync — 다른 디바이스의 jsonl을 내 DB로 import.
  // MVP: append-only 테이블 8종만. 상태 테이블은 제외. 기본 false (opt-in).
  nasImportEnabled?: boolean;

  // v4.19.0: 주말 백테스트 저장 최소 거래 수 (통계적 유의성 하한).
  // 기본 5 (v4.17.0 유지). signal_performance·backtest_results 충분히 쌓이면
  // 30으로 상향 권장. undefined이면 5.
  backtestMinTradesForSave?: number;
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
  targetProfitRate: number;      // +N% → 전량 매도 (ROI table fallback)
  hardStopLossRate: number;      // -N% → 전량 매도
  trailingStopRate: number;      // 고점 대비 -N% → 전량 매도
  maxHoldMinutes: number;        // N분 초과 → 전량 매도 (ROI table이 있으면 tail로 사용)

  // v4.16.0: ROI Table (freqtrade 영감) — 시간 경과에 따른 목표 수익률 감쇠.
  // 형식: [[minutes, profitPct], ...] — 경과 시간별 익절 임계값.
  // 예: [[0, 3.0], [30, 2.0], [60, 1.0], [120, 0]]
  //     매수 직후 3% 익절, 30분 후 2%, 60분 후 1%, 120분 후 손익무관 청산.
  // 미설정(undefined)이면 기존 targetProfitRate + maxHoldMinutes 방식 유지 (후방 호환).
  roiTable?: Array<[number, number]>;

  // 포지션 사이징
  positionMaxRatio: number;      // 전체 예산의 N%
  positionMinCashRatio: number;  // 현금 N% 미만이면 매수 금지
  positionMaxPositions: number;  // 최대 동시 보유 종목 수

  // 동적 스크리닝
  dynamicScreeningEnabled: boolean;
  screeningVolumeRatioMin: number;  // RISING: 5일 평균 거래량의 N배
  screeningMinMarketCap: number;    // FLAT: 시가총액 N억 이상

  // v4.10.0: 가상매매(Paper Trading)
  paperTradingEnabled: boolean;     // 추천 BUY 신호 → 실매매 안 된 종목 자동 가상매수
  paperTradeAmount: number;         // 가상매수 종목당 금액 (KRW, 해외도 환산)

  // v4.16.0: Protection 시스템 (freqtrade 영감) — 전략 수준 circuit breaker.
  // 지정되지 않으면 DEFAULT_PROTECTION_CONFIG 사용.
  protections?: {
    stoplossGuard?: { enabled?: boolean; lookbackHours?: number; stopLossLimit?: number };
    cooldownPeriod?: { enabled?: boolean; cooldownMinutes?: number };
    lowProfitPairs?: { enabled?: boolean; lookbackTrades?: number; requiredProfitPercent?: number };
    // v4.17.0: 백테스트 기반 차단
    backtestReject?: { enabled?: boolean; minProfitFactor?: number; maxAgeHours?: number; minTrades?: number };
  };
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

  paperTradingEnabled: true,
  paperTradeAmount: 1_000_000,
};

// ─── v4.15.0: 전략 프리셋 ───────────────────────────────────
// 사용자가 선택한 파라미터 (maxHoldMinutes=60, targetProfit=3% 등)는
// 스캘핑 전용. 애널리스트 관점에서 스윙/포지션 스타일도 선택 가능하도록
// 프리셋 상수를 제공한다. 설정은 자동 변경되지 않음 — 사용자가 적용 API 호출 시.
export type TradingPresetName = 'scalping' | 'intraday' | 'swing' | 'position';

export interface TradingPreset {
  name: TradingPresetName;
  label: string;
  description: string;
  targetProfitRate: number;
  hardStopLossRate: number;
  trailingStopRate: number;
  maxHoldMinutes: number;
  investmentStyle: AppSettings['investmentStyle'];
  // v4.16.0: freqtrade 스타일 ROI 테이블. 시간 경과별 목표 수익률 감쇠.
  roiTable: Array<[number, number]>;
}

export const TRADING_PRESETS: Record<TradingPresetName, TradingPreset> = {
  scalping: {
    name: 'scalping',
    label: '스캘핑 (1시간 내)',
    description: '1시간 내 ±2~3% 타겟. 초단타, 회전율 극대화. 거래비용 부담 큼.',
    targetProfitRate: 3.0,
    hardStopLossRate: 2.0,
    trailingStopRate: 1.5,
    maxHoldMinutes: 60,
    investmentStyle: 'momentum',
    // 초기 3% 익절, 20분 후엔 2%, 40분 후엔 1%, 60분엔 손익 무관 청산
    roiTable: [[0, 3.0], [20, 2.0], [40, 1.0], [60, 0]],
  },
  intraday: {
    name: 'intraday',
    label: '데이트레이딩 (당일 청산)',
    description: '당일 내 청산. 타겟 ±3~5%. 오버나잇 리스크 회피.',
    targetProfitRate: 4.0,
    hardStopLossRate: 2.5,
    trailingStopRate: 2.0,
    maxHoldMinutes: 360, // 6시간
    investmentStyle: 'momentum',
    roiTable: [[0, 5.0], [60, 3.0], [180, 1.5], [360, 0]],
  },
  swing: {
    name: 'swing',
    label: '스윙 (며칠~2주)',
    description: '며칠 ~ 2주 보유. 타겟 ±7~10%. 시장 잡음 필터링.',
    targetProfitRate: 8.0,
    hardStopLossRate: 4.0,
    trailingStopRate: 3.5,
    maxHoldMinutes: 60 * 24 * 7, // 1주
    investmentStyle: 'balanced',
    // 하루 내 8%+ 이면 즉시 익절, 2일 후 6%, 4일 후 4%, 1주 후 손익무관
    roiTable: [[0, 10.0], [60 * 24, 8.0], [60 * 24 * 2, 6.0], [60 * 24 * 4, 4.0], [60 * 24 * 7, 0]],
  },
  position: {
    name: 'position',
    label: '포지션 (장기 가치)',
    description: '수주~수개월 보유. 타겟 ±20%+. 일중 변동 무시.',
    targetProfitRate: 20.0,
    hardStopLossRate: 8.0,
    trailingStopRate: 6.0,
    maxHoldMinutes: 60 * 24 * 30, // 1달
    investmentStyle: 'value',
    // 1주 내 25%+ 이면 익절, 2주 후 20%, 1달 후 10%, 1달 경과 시 청산
    roiTable: [[0, 25.0], [60 * 24 * 7, 20.0], [60 * 24 * 14, 15.0], [60 * 24 * 30, 10.0]],
  },
};

/** 프리셋을 부분 설정 오브젝트로 반환. 사용자가 적용 시 이 값으로 merge. */
export function getPresetPatch(name: TradingPresetName): Partial<AppSettings> {
  const p = TRADING_PRESETS[name];
  return {
    targetProfitRate: p.targetProfitRate,
    hardStopLossRate: p.hardStopLossRate,
    trailingStopRate: p.trailingStopRate,
    maxHoldMinutes: p.maxHoldMinutes,
    investmentStyle: p.investmentStyle,
    roiTable: p.roiTable,
  };
}

let _cache: AppSettings | null = null;

/**
 * Legacy fields that were once stored in settings.json but are no longer used
 * by any code path. They are stripped on load and on save so the file
 * eventually self-cleans without forcing a manual migration.
 *
 * v4.5.0 introduced externalAi* fields for an external AI provider option,
 * but the project pivoted to local-only Ollama. Those fields became dead
 * config and a needless source of leaked secrets in NAS sync exports.
 *
 * v4.12.0 removed Ollama entirely and switched to MLX. The ollama* fields
 * are now legacy and self-clean over time.
 *
 * v4.13.0 removed bundled MLX and switched to a generic external OpenAI-
 * compatible endpoint (llm*). The mlx* fields are migrated once (see
 * getSettings) and then treated as legacy to self-clean over time.
 */
const LEGACY_FIELDS = [
  'externalAiApiKey',
  'externalAiProvider',
  'externalAiModel',
  'ollamaUrl',
  'ollamaModel',
  'ollamaEnabled',
  'mlxUrl',
  'mlxModel',
  'mlxEnabled',
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

      // v4.13.0 migration: 기존 mlx* 설정이 있으면 llm* 로 이관 (한 번만).
      // 구 MLX 기본 URL(http://localhost:8000)은 더 이상 유효하지 않으므로
      // 새 기본값(https://ai.unids.kr/v1)으로 대체. 사용자가 다른 URL로
      // 커스터마이즈한 경우는 보존(사용자 의도를 존중).
      const needsLlmMigration =
        rawParsed.mlxEnabled !== undefined && rawParsed.llmEnabled === undefined;
      if (needsLlmMigration) {
        if (rawParsed.mlxEnabled !== undefined) rawParsed.llmEnabled = !!rawParsed.mlxEnabled;
        if (typeof rawParsed.mlxUrl === 'string') {
          rawParsed.llmUrl = rawParsed.mlxUrl === 'http://localhost:8000'
            ? 'https://ai.unids.kr/v1'
            : rawParsed.mlxUrl;
        }
        // llmModel: 이전 MLX 모델명 포맷은 외부 OpenAI-호환 서버에서
        // 통용되지 않을 수 있으므로 빈 값으로 리셋 → 사용자 재선택 유도.
        rawParsed.llmModel = '';
      }

      const parsed = stripLegacyFields(rawParsed);
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
  if (ENV_SECRETS.llmApiKey) _cache!.llmApiKey = ENV_SECRETS.llmApiKey;

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
  const { kisAppKey, kisAppSecret, dartApiKey, llmApiKey, ...safeSettings } = _cache;
  const toSave = {
    ...safeSettings,
    ...(ENV_SECRETS.kisAppKey ? {} : { kisAppKey }),
    ...(ENV_SECRETS.kisAppSecret ? {} : { kisAppSecret }),
    ...(ENV_SECRETS.dartApiKey ? {} : { dartApiKey }),
    ...(ENV_SECRETS.llmApiKey ? {} : { llmApiKey }),
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
