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

  // v6.0 종목 선택 방식 + 200일선 레짐 필터
  selectionMode: z.enum(['marketcap', 'momentum']).optional(),
  regimeFilterEnabled: z.boolean().optional(),
  nxtTradingEnabled: z.boolean().optional(),

  // v6.1.2 트레일링 익절 — 활성 수익률(1~100%) + 고점 대비 하락폭(0.5~20%)
  trailingActivatePercent: z.number().min(1).max(100).optional(),
  trailingStopDropPercent: z.number().min(0.5).max(20).optional(),
});

// ── 수동 주문 (포트폴리오 화면 → 실제 KIS 주문) ──

export const manualOrderSchema = z.object({
  stock_id: z.number({ error: '종목 ID는 필수입니다' }).positive(),
  type: z.enum(['BUY', 'SELL'], { error: '거래 유형은 BUY 또는 SELL이어야 합니다' }),
  quantity: z.number({ error: '수량은 필수입니다' }).int('수량은 정수여야 합니다').positive('수량은 양수여야 합니다'),
  price: z.number().min(0, '가격은 0 이상이어야 합니다').default(0), // 0 = 시장가/현재가 자동 결정
  memo: z.string().default(''),
});

// ── 종목 거래 고정(잠금) — 자동매매 매도/재분배 제외 ──

export const lockStockSchema = z.object({
  stock_id: z.number({ error: '종목 ID는 필수입니다' }).positive(),
  locked: z.boolean({ error: 'locked는 true 또는 false 여야 합니다' }),
});

// ── System Events ──

export const resolveEventSchema = z.object({
  resolution: z.string().default('수동 해결'),
});

export const configRestoreSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});
