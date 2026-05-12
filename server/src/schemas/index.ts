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

// ── Config (v5.6.0 라이트 모드 — Top 10 전략 전용) ──

export const saveConfigSchema = z.object({
  // KIS 인증
  appKey: z.string().min(1, 'AppKey는 필수입니다'),
  appSecret: z.string().optional(),
  accountNo: z.string().default(''),
  accountProductCode: z.string().default('01'),
  isVirtual: z.boolean().default(true),

  // 자동매매 ON/OFF
  autoTradeEnabled: z.boolean().default(false),

  // 매매 스케줄 (KRX)
  scheduleKrx: z.object({
    enabled: z.boolean(),
  }).optional(),

  // 시장 브레이크 (안전망)
  marketBrakeEnabled: z.boolean().default(true),
  marketBrakeKospiPercent: z.number().min(0.5).max(10).default(2.0),
  marketBrakeVixLevel: z.number().min(15).max(80).default(30),
});

// ── System Events ──

export const resolveEventSchema = z.object({
  resolution: z.string().default('수동 해결'),
});

export const configRestoreSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});
