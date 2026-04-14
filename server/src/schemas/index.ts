import { z } from 'zod';

// ── Stocks ──

export const createStockSchema = z.object({
  ticker: z.string().min(1, '종목코드는 필수입니다').transform(v => v.toUpperCase()),
  name: z.string().min(1, '이름은 필수입니다'),
  market: z.string().default(''),
  sector: z.string().default(''),
});

export const updateStockSchema = z.object({
  ticker: z.string().optional(),
  name: z.string().optional(),
  market: z.string().optional(),
  sector: z.string().optional(),
});

// ── Transactions ──

export const createTransactionSchema = z.object({
  stock_id: z.number({ error: '종목 ID는 필수입니다' }).positive(),
  type: z.enum(['BUY', 'SELL'], { error: '거래 유형은 BUY 또는 SELL이어야 합니다' }),
  quantity: z.number({ error: '수량은 필수입니다' }).positive('수량은 양수여야 합니다'),
  price: z.number({ error: '가격은 필수입니다' }).min(0, '가격은 0 이상이어야 합니다'),
  fee: z.number().min(0).default(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜는 YYYY-MM-DD 형식이어야 합니다'),
  memo: z.string().default(''),
});

// ── Dividends ──

export const createDividendSchema = z.object({
  stock_id: z.number({ error: '종목 ID는 필수입니다' }).positive(),
  amount: z.number({ error: '금액은 필수입니다' }).positive('금액은 양수여야 합니다'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜는 YYYY-MM-DD 형식이어야 합니다'),
  memo: z.string().default(''),
});

// ── Alerts ──

export const createAlertSchema = z.object({
  stock_id: z.number({ error: '종목 ID는 필수입니다' }).positive(),
  type: z.enum(['PRICE_ABOVE', 'PRICE_BELOW', 'PROFIT_TARGET'], {
    error: '유효하지 않은 알림 유형입니다',
  }),
  value: z.number({ error: '값은 필수입니다' }),
});

export const updateAlertSchema = z.object({
  is_active: z.boolean(),
});

// ── Watchlist ──

export const createWatchlistSchema = z.object({
  stock_id: z.number({ error: 'stock_id는 필수입니다' }).positive(),
  market: z.string().optional(),
  notes: z.string().default(''),
  auto_trade_enabled: z.boolean().default(false),
});

export const updateWatchlistSchema = z.object({
  auto_trade_enabled: z.boolean().optional(),
  notes: z.string().optional(),
}).refine(data => data.auto_trade_enabled !== undefined || data.notes !== undefined, {
  message: '변경할 항목이 없습니다',
});

// ── Recommendations ──

export const createRecommendationSchema = z.object({
  ticker: z.string().min(1, 'ticker는 필수입니다'),
  name: z.string().min(1, 'name은 필수입니다'),
  market: z.string().default('KRX'),
  source: z.string().default(''),
  reason: z.string().default(''),
  signal_type: z.enum(['BUY', 'SELL', 'HOLD']).default('BUY'),
  confidence: z.number().min(0).max(100).default(0),
  expires_at: z.string().nullable().optional(),
});

export const updateRecommendationStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'EXECUTED', 'EXPIRED', 'DISMISSED'], {
    error: '유효하지 않은 상태',
  }),
});

export const generateRecommendationSchema = z.object({
  market: z.string().default('KRX'),
});

// ── Analysis ──

export const decisionSchema = z.object({
  phase: z.enum(['PRE_OPEN', 'POST_OPEN', 'PRE_CLOSE_1H', 'PRE_CLOSE_30M']).default('PRE_OPEN'),
});

export const pullModelSchema = z.object({
  model: z.string().min(1, '모델명이 필요합니다'),
});

// ── Chart / Config ──

export const saveConfigSchema = z.object({
  appKey: z.string().min(1, 'AppKey는 필수입니다'),
  appSecret: z.string().optional(),
  accountNo: z.string().default(''),
  accountProductCode: z.string().default('01'),
  isVirtual: z.boolean().default(true),
  mcpEnabled: z.boolean().default(false),

  // v4.12.0: MLX (Apple Silicon 전용, OpenAI-compat API)
  mlxUrl: z.string()
    .refine(val => {
      if (!val) return true; // allow empty (will use default)
      try {
        const u = new URL(val);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        // Block cloud metadata endpoints (SSRF 가드)
        const blocked = ['169.254.169.254', '100.100.100.200', 'metadata.google.internal'];
        if (blocked.includes(u.hostname)) return false;
        return true;
      } catch { return false; }
    }, { message: 'mlxUrl은 유효한 http/https URL이어야 합니다' })
    .default('http://localhost:8000'),
  mlxModel: z.string().default('mlx-community/gemma-3n-E4B-it-4bit'),
  mlxEnabled: z.boolean().default(true),

  dartApiKey: z.string().optional(),
  dartEnabled: z.boolean().default(false),

  investmentStyle: z.enum(['balanced', 'value', 'growth', 'momentum']).default('balanced'),
  debateMode: z.boolean().default(false),
  stopLossPercent: z.number().min(0).max(100).default(3),

  autoTradeEnabled: z.boolean().default(false),
  autoTradeMaxInvestment: z.number().positive().default(10000000),
  autoTradeMaxPerStock: z.number().positive().default(2000000),
  autoTradeMaxDailyTrades: z.number().int().positive().default(10),
  autoTradeScoreThreshold: z.number().min(50).max(200).default(100),
  priceChangeThreshold: z.number().min(0.5).max(10).default(2),

  portfolioMaxHoldings: z.number().int().min(3).max(50).default(10),
  portfolioMaxPerStockPercent: z.number().min(5).max(50).default(20),
  portfolioMaxSectorPercent: z.number().min(20).max(80).default(40),
  portfolioRebalanceEnabled: z.boolean().default(false),
  portfolioMinCashPercent: z.number().min(0).max(50).default(10),

  scheduleKrx: z.object({
    enabled: z.boolean(),
    preOpen: z.boolean(),
    postOpen: z.boolean(),
    preClose1h: z.boolean(),
    preClose30m: z.boolean(),
  }).optional(),
  scheduleNyse: z.object({
    enabled: z.boolean(),
    preOpen: z.boolean(),
    postOpen: z.boolean(),
    preClose1h: z.boolean(),
    preClose30m: z.boolean(),
  }).optional(),

  nasSyncEnabled: z.boolean().default(false),
  nasSyncPath: z.string().default('/Volumes/stock-manager'),
  nasSyncTime: z.string().regex(/^[\d*\/,-]+ [\d*\/,-]+ [\d*\/,-]+ [\d*\/,-]+ [\d*\/,-]+$/).or(z.literal('')).default('0 20 * * *'),
  deviceId: z.string().default(''),
  nasHost: z.string().default(''),
  nasShare: z.string().default('stock-manager'),
  nasUsername: z.string().default(''),
  nasPassword: z.string().default(''),
  nasAutoMount: z.boolean().default(true),

  tradingRulesEnabled: z.boolean().default(true),
  tradingRulesStrictMode: z.boolean().default(false),
  gapThresholdPercent: z.number().min(0.5).max(20).default(3),
  volumeSurgeRatio: z.number().min(1).max(5).default(1.5),
  lowVolumeRatio: z.number().min(0.1).max(1).default(0.7),
  sidewaysAtrPercent: z.number().min(0.1).max(5).default(1.0),

  // 매도 규칙
  sellRulesEnabled: z.boolean().default(true),
  targetProfitRate: z.number().min(0.5).max(50).default(3.0),
  hardStopLossRate: z.number().min(0.5).max(50).default(2.0),
  trailingStopRate: z.number().min(0.3).max(20).default(1.5),
  maxHoldMinutes: z.number().int().min(5).max(1440).default(60),

  // 포지션 사이징
  positionMaxRatio: z.number().min(5).max(100).default(25),
  positionMinCashRatio: z.number().min(0).max(80).default(20),
  positionMaxPositions: z.number().int().min(1).max(20).default(3),

  // 동적 스크리닝
  dynamicScreeningEnabled: z.boolean().default(true),
  screeningVolumeRatioMin: z.number().min(1).max(10).default(1.5),
  screeningMinMarketCap: z.number().min(0).default(500),

  // 가상매매 (v4.10.0)
  paperTradingEnabled: z.boolean().default(true),
  paperTradeAmount: z.number().int().positive().default(1_000_000),
});

// ── System Events ──

export const resolveEventSchema = z.object({
  resolution: z.string().default('수동 해결'),
});

// ── Feedback ──

const candleItemSchema = z.object({
  time: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
}).passthrough();

export const backtestSchema = z.object({
  name: z.string().min(1, 'name은 필수입니다'),
  candles: z.array(candleItemSchema).min(60, '최소 60개 캔들 데이터가 필요합니다').max(2000, '최대 2000개 캔들까지 허용됩니다'),
  initialCapital: z.number().positive('initialCapital은 양수여야 합니다'),
  ticker: z.string().optional(),
  market: z.string().optional(),
});

export const configRestoreSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

export const strategyImportSchema = z.object({
  version: z.string(),
  settings: z.record(z.string(), z.unknown()),
  weights: z.record(z.string(), z.unknown()),
});

// ── Trading Rules ──

export const updateTradingRuleSchema = z.object({
  is_enabled: z.boolean().optional(),
  params_json: z.record(z.string(), z.number()).optional(),
}).refine(data => data.is_enabled !== undefined || data.params_json !== undefined, {
  message: '변경할 항목이 없습니다',
});
