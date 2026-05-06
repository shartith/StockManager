import { z } from 'zod';

// ── Stocks ──

export const createStockSchema = z.object({
  ticker: z.string().min(1, '종목코드는 필수입니다').transform(v => v.toUpperCase()),
  name: z.string().min(1, '이름은 필수입니다'),
  market: z.string().default('KRX'),
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

// ── Alerts ──

export const createAlertSchema = z.object({
  stock_id: z.number({ error: '종목 ID는 필수입니다' }).positive(),
  type: z.enum(['PRICE_ABOVE', 'PRICE_BELOW', 'PROFIT_TARGET']),
  value: z.number({ error: '값은 필수입니다' }),
});

export const updateAlertSchema = z.object({
  is_active: z.boolean(),
});

// ── Chart / Config (v5.0.0 슬림화) ──

export const saveConfigSchema = z.object({
  appKey: z.string().min(1, 'AppKey는 필수입니다'),
  appSecret: z.string().optional(),
  accountNo: z.string().default(''),
  accountProductCode: z.string().default('01'),
  isVirtual: z.boolean().default(true),
  mcpEnabled: z.boolean().default(false),

  // 외부 OpenAI 호환 LLM
  llmUrl: z.string()
    .refine(val => {
      if (!val) return true;
      try {
        const u = new URL(val);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const blocked = ['169.254.169.254', '100.100.100.200', 'metadata.google.internal'];
        if (blocked.includes(u.hostname)) return false;
        return true;
      } catch { return false; }
    }, { message: 'llmUrl은 유효한 http/https URL이어야 합니다' })
    .default('https://ai.unids.kr/v1'),
  llmModel: z.string().default(''),
  llmEnabled: z.boolean().default(true),
  llmApiKey: z.string().default(''),
  llmProvider: z.enum(['ollama', 'openai']).default('openai'),

  dartApiKey: z.string().optional(),
  dartEnabled: z.boolean().default(false),

  // 자동매매 ON/OFF (한도는 KIS 잔고에서 자동 산정)
  autoTradeEnabled: z.boolean().default(false),

  // 매매 스케줄
  scheduleKrx: z.object({
    enabled: z.boolean(),
  }).optional(),

  // 매도 규칙
  sellRulesEnabled: z.boolean().default(true),
  targetProfitRate: z.number().min(0.5).max(50).default(3.0),
  hardStopLossRate: z.number().min(0.5).max(50).default(2.0),
  trailingStopRate: z.number().min(0.3).max(20).default(1.5),
  trailingActivatePercent: z.number().min(0.5).max(20).default(3.0),
  sidewaysMinutes: z.number().int().min(5).max(360).default(60),
  lossMinutes: z.number().int().min(5).max(360).default(60),
  profitThresholdPercent: z.number().min(0).max(5).default(0.5),

  // 포지션 사이징
  positionMaxPositions: z.number().int().min(1).max(20).default(5),

  // EOD
  eodProfitTakePercent: z.number().min(0.5).max(20).default(3.0),

  // 매수 게이트
  entryGainPercent: z.number().min(0.1).max(10).default(1.0),
  marketBrakeEnabled: z.boolean().default(true),
  marketBrakeKospiPercent: z.number().min(0.5).max(10).default(2.0),
  marketBrakeVixLevel: z.number().min(15).max(80).default(30),
  gapUpMaxPercent: z.number().min(0.5).max(15).default(3.0),
  reEntryCooldownMinutes: z.number().int().min(0).max(360).default(30),
});

// ── System Events ──

export const resolveEventSchema = z.object({
  resolution: z.string().default('수동 해결'),
});

export const configRestoreSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});
