// -- Scoring thresholds (defaults, overridable via settings) --
export const WATCHLIST_PROMOTION_THRESHOLD = 80;
export const AUTO_TRADE_THRESHOLD = 100;
export const MIN_SIGNAL_CONFIDENCE = 60;
export const LOW_CONFIDENCE_DISABLE = 40;

// -- Technical analysis --
export const MIN_CANDLES_FOR_ANALYSIS = 30;
export const TREND_THRESHOLD = 0.3;

// -- Scheduler --
export const MAX_SCHEDULER_LOGS = 100;
export const INTER_STOCK_DELAY_MS = 100;
export const PRICE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_PRICE_CHANGE_THRESHOLD = 2; // % — 연속 모니터링 가격 변동 임계값

// -- Watchlist cleanup --
export const WATCHLIST_STALE_DAYS = 30;
export const LOW_SCORE_STALE_DAYS = 14;

// -- LoRA --
export const LORA_MIN_DATASET_COUNT = 5000;

// -- Rate limits --
export const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const API_RATE_LIMIT_MAX = 120;

// -- WebSocket --
export const WS_TOKEN_TTL_MS = 30 * 1000;

// ── Trading Rules ──
export const DEFAULT_GAP_THRESHOLD_PERCENT = 3;
export const DEFAULT_VOLUME_SURGE_RATIO = 1.5;
export const DEFAULT_LOW_VOLUME_RATIO = 0.7;
export const DEFAULT_SIDEWAYS_ATR_PERCENT = 1.0;
