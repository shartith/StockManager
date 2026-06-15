/**
 * 설정 관리 (v6.1 라이트 모드).
 *
 * 노출 필드: KIS 인증 + 자동매매 ON/OFF + KRX 스케줄 + 시장 브레이크
 *           + 매매전략(시총/모멘텀, 200일선 레짐, NXT) + 트레일링 익절(활성률/하락폭).
 *
 * v5.6 제거:
 *   LLM (llmProvider, llmUrl, llmModel, llmEnabled, llmApiKey, llmFallbackUrl 등)
 *   DART (dartApiKey, dartEnabled)
 *   sellRules 11종 (targetProfitRate, hardStopLossRate 등)
 *   매수 게이트 (entryGainPercent, gapUpMaxPercent, reEntryCooldownMinutes)
 *   포지션 (positionMaxPositions — Top10 고정 10)
 *   EOD (eodProfitTakePercent)
 *   strategyMode (top10 only)
 *   mcpEnabled
 *
 * v6.1.2 재노출:
 *   trailingActivatePercent / trailingStopDropPercent — 트레일링 익절 임계값.
 *   (rebalanceStrategy 의 상수 → 설정값으로. 미설정 시 기존 10% / 2% 기본값 유지)
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

  // v6.0 종목 선택 방식
  //   'marketcap' = 시총 Top 10 추종 (v5.8 기존)
  //   'momentum'  = 시총 Top 30 중 가격 모멘텀(120일) 상위 매수 (백테스트 복리 2배)
  selectionMode: 'marketcap' | 'momentum';
  // 200일선 레짐 필터 — KOSPI 가 200일선 아래면 신규 매수 중단(보유 유지). 약세장 방어.
  regimeFilterEnabled: boolean;

  // v6.1 NXT(넥스트레이드) 거래
  //   true  = 메인장 SOR(최선주문집행) + 프리/애프터마켓(08~09, 15:30~20시) 자동매매
  //   false = KRX 전용 (현행, 검증된 경로) — NXT 신청 확인 후 켜기 권장
  nxtTradingEnabled: boolean;

  // 트레일링 익절 (S1 매도 규칙)
  //   trailingActivatePercent = 수익 +이 %(기본 10) 도달 시 트레일링 감시 시작
  //   trailingStopDropPercent = 활성 후 고점 대비 -이 %(기본 2) 이탈 시 매도
  // 즉시 익절이 아니라 "고점 추적 후 되돌림 매도" — 추가 상승분을 보호한다.
  trailingActivatePercent: number;
  trailingStopDropPercent: number;
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

  // 기본은 기존 동작 유지 — 사장님이 dry-run 관찰 후 'momentum' 으로 전환
  selectionMode: 'marketcap',
  regimeFilterEnabled: false,

  // NXT 기본 OFF — 계좌 NXT 신청 확인 + 관찰모드 검증 후 켜기
  nxtTradingEnabled: false,

  // 트레일링 익절 — 백테스트로 확정된 기존 상수값(10% 활성 / 2% 하락)을 기본값으로
  trailingActivatePercent: 10,
  trailingStopDropPercent: 2,
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
  'trailingStopRate', // v6.1.2: trailingActivatePercent 는 재노출되어 legacy 에서 제외
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
