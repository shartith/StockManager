// ============================================================
// Domain Models
// ============================================================

export interface Stock {
  id: number;
  ticker: string;
  name: string;
  market: string;
  sector: string;
  category: string;
  created_at: string;
}

export interface Transaction {
  id: number;
  stock_id: number;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  fee: number;
  date: string;
  memo: string;
  ticker?: string;
  name?: string;
}

export interface Dividend {
  id: number;
  stock_id: number;
  amount: number;
  date: string;
  memo: string;
  ticker?: string;
  name?: string;
}

export interface Alert {
  id: number;
  stock_id: number;
  type: 'PRICE_ABOVE' | 'PRICE_BELOW' | 'PROFIT_TARGET';
  value: number;
  is_active: boolean;
  ticker?: string;
  name?: string;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  ticker: string;
  market: string;
  is_read: boolean;
  action_url: string;
  created_at: string;
}

// ============================================================
// Portfolio
// ============================================================

export interface HoldingItem {
  stockId: number;
  ticker: string;
  name: string;
  market: string;
  sector: string;
  buyQuantity: number;
  sellQuantity: number;
  quantity: number;
  avgPrice: number;
  totalCost: number;
  currentPrice: number | null;
  currentValue: number | null;
  profitLoss: number | undefined;
  profitLossPercent: number | undefined;
  latestSignal?: string;
  latestConfidence?: number;
}

export interface AllocationItem {
  label: string;
  value: number;
  percent: number;
}

export interface PortfolioSummary {
  totalInvested: number;
  totalCurrentValue: number;
  totalProfitLoss: number;
  totalProfitLossPercent: number;
  totalDividends: number;
  totalFees: number;
  holdings: HoldingItem[];
  allocation: AllocationItem[];
  allocationBy?: string;
}

export interface OptimalWeight {
  ticker: string;
  currentPercent: number;
  optimalPercent: number;
  action: 'INCREASE' | 'DECREASE' | 'HOLD';
}

export interface CorrelationPair {
  pair: string;
  correlation: number;
}

export interface PortfolioInsight {
  highCorrelationPairs: CorrelationPair[];
  optimalWeights: OptimalWeight[];
}

// ============================================================
// Recommendations
// ============================================================

export interface Recommendation {
  id: number;
  ticker: string;
  name: string;
  market: string;
  source: string;
  reason: string;
  signal_type: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  status: 'ACTIVE' | 'EXECUTED' | 'EXPIRED' | 'DISMISSED';
  score: number;
  consecutive_buys: number;
  category: string;
  created_at: string;
  expires_at: string;
}

// ============================================================
// Watchlist
// ============================================================

export interface WatchlistItem {
  id: number;
  stock_id: number;
  market: string;
  notes: string;
  auto_trade_enabled: boolean;
  added_at: string;
  ticker?: string;
  name?: string;
  latestSignal?: string;
  latestConfidence?: number;
  currentPrice?: number;
}

// ============================================================
// Trade Signals
// ============================================================

export interface TradeSignal {
  id: number;
  stock_id: number;
  signal_type: string;
  source: string;
  confidence: number;
  indicators_json: string;
  llm_reasoning: string;
  created_at: string;
}

// ============================================================
// System Events
// ============================================================

export type EventSeverity = 'CRITICAL' | 'ERROR' | 'WARN' | 'INFO';

export interface SystemEvent {
  id: number;
  severity: EventSeverity;
  category: string;
  title: string;
  detail: string;
  ticker: string;
  resolved: boolean;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string;
}

export interface EventCounts {
  total: number;
  unresolved: number;
  bySeverity: Record<EventSeverity, number>;
  critical: number;
  error: number;
}

// ============================================================
// Backtest
// ============================================================

export interface BacktestResult {
  id: number;
  name: string;
  ticker: string;
  market: string;
  start_date: string;
  end_date: string;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  created_at: string;
}

// ============================================================
// Scheduler
// ============================================================

export interface SchedulerLog {
  market: 'KRX' | 'NYSE' | 'NASDAQ';
  phase: string;
  status: 'started' | 'completed' | 'error';
  timestamp: string;
  message: string;
}

export interface SchedulerStatus {
  active: boolean;
  taskCount: number;
  krxEnabled: boolean;
  nyseEnabled: boolean;
  autoTradeEnabled: boolean;
  recentLogs: SchedulerLog[];
}

// ============================================================
// Balance (KIS)
// ============================================================

export interface BalanceHolding {
  ticker: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  totalValue: number;
  profitLossRate: number;
}

export interface OverseasBalanceHolding extends BalanceHolding {
  market: string;
}

export interface BalanceData {
  totalEvalAmount: number;
  totalPurchaseAmount: number;
  totalProfitLoss: number;
  depositAmount: number;
  orderableAmount: number;
  withdrawableAmount: number;
  holdings: BalanceHolding[];
  overseasHoldings: OverseasBalanceHolding[];
  overseasTotalEvalAmount: number;
  overseasTotalPurchaseAmount: number;
  overseasTotalProfitLoss: number;
  overseasDepositAmount: number;
}

// ============================================================
// Market Context
// ============================================================

export interface MarketIndex {
  price: number;
  changePercent: number;
}

export interface MarketContext {
  kospi: MarketIndex | null;
  kosdaq: MarketIndex | null;
  sp500: MarketIndex | null;
  vix: MarketIndex | null;
  usdKrw: MarketIndex | null;
  dow: MarketIndex | null;
}

// ============================================================
// Dashboard System Status
// ============================================================

export interface SystemStatus {
  schedulerActive: boolean;
  taskCount: number;
  ollamaConnected: boolean;
  todayBuy: number;
  todaySell: number;
  todayHold: number;
}

// ============================================================
// Analysis
// ============================================================

export interface AnalysisIndicators {
  rsi14: number | null;
  macd: number | null;
  vwap: number | null;
  atr14: number | null;
  sma5: number | null;
  sma20: number | null;
  sma60: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  signal: 'BUY' | 'SELL' | 'HOLD';
  signalReasons: string[];
}

export interface AnalysisResult {
  indicators: AnalysisIndicators;
  dataPoints: number;
}

// ============================================================
// Trading Rules
// ============================================================

export interface TradingRule {
  id: number;
  rule_id: string;
  name: string;
  description: string;
  category: 'TIME' | 'VOLUME' | 'VOLATILITY' | 'CANDLE' | 'SUPPORT';
  is_enabled: boolean;
  priority: number;
  params_json: string;
}

// ============================================================
// Import Result
// ============================================================

export interface ImportResult {
  message?: string;
  error?: string;
  imported?: string[];
}

// ============================================================
// NAS Sync
// ============================================================

export interface NasSyncStatus {
  enabled: boolean;
  lastSync: {
    lastSyncAt: string;
    deviceId: string;
    tablesExported: number;
    totalRecords: number;
  } | null;
  nasPath: string;
  deviceId: string;
}

export interface NasSyncResult {
  success: boolean;
  message: string;
  tablesExported: number;
  totalRecords: number;
  syncPath: string;
  timestamp: string;
}

export interface NasValidateResult {
  valid: boolean;
  message: string;
}
