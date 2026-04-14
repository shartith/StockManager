import axios from 'axios';
import type { AxiosError } from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// ─── Global error reporting (v4.7.0) ────────────────────────
//
// A single source of truth for surfacing API errors. Components used to
// have ~18 empty `catch {}` blocks that swallowed errors silently. The
// interceptor below extracts a useful message from the axios error and
// hands it to the global toast handler installed by App.vue at boot time.
//
// Components that intentionally want to handle an error locally (e.g. the
// settings save flow that shows inline validation messages) can opt out by
// passing { suppressGlobalToast: true } in the request config.
type ToastReporter = (message: string, opts?: { type?: 'error' | 'warning' }) => void;

let toastReporter: ToastReporter | null = null;

export function setGlobalErrorReporter(fn: ToastReporter): void {
  toastReporter = fn;
}

function extractErrorMessage(error: AxiosError<{ error?: string; message?: string }>): string {
  const data = error.response?.data;
  if (data?.error) return data.error;
  if (data?.message) return data.message;
  if (error.message) return error.message;
  return 'API 요청 실패';
}

api.interceptors.response.use(
  response => response,
  (error: AxiosError) => {
    const config = error.config as { suppressGlobalToast?: boolean } | undefined;
    if (!config?.suppressGlobalToast && toastReporter) {
      const status = error.response?.status;
      // Network errors and 5xx → user-visible toast.
      // 4xx (validation, auth) is left to the caller because the UX is
      // usually inline (form errors, login prompts).
      if (!status || status >= 500) {
        toastReporter(extractErrorMessage(error as AxiosError<{ error?: string }>));
      }
    }
    return Promise.reject(error);
  },
);

// 종목 API
export const stocksApi = {
  getAll: () => api.get('/stocks'),
  get: (id: number) => api.get(`/stocks/${id}`),
  create: (data: { ticker: string; name: string; market?: string; sector?: string }) =>
    api.post('/stocks', data),
  update: (id: number, data: Partial<{ ticker: string; name: string; market: string; sector: string }>) =>
    api.put(`/stocks/${id}`, data),
  delete: (id: number) => api.delete(`/stocks/${id}`),
};

// 거래 API
export const transactionsApi = {
  getAll: (params?: { stock_id?: number; type?: string; limit?: number; offset?: number }) =>
    api.get('/transactions', { params }),
  create: (data: { stock_id: number; type: 'BUY' | 'SELL'; quantity: number; price: number; fee?: number; date: string; memo?: string }) =>
    api.post('/transactions', data),
  delete: (id: number) => api.delete(`/transactions/${id}`),
};

// 포트폴리오 API
export const portfolioApi = {
  getSummary: () => api.get('/portfolio/summary'),
  getInsight: () => api.get('/portfolio/insight'),
  getHistory: () => api.get('/portfolio/history'),
};

// 배당금 API
export const dividendsApi = {
  getAll: (params?: { stock_id?: number }) => api.get('/dividends', { params }),
  create: (data: { stock_id: number; amount: number; date: string; memo?: string }) =>
    api.post('/dividends', data),
  delete: (id: number) => api.delete(`/dividends/${id}`),
};

// 알림 API
export const alertsApi = {
  getAll: () => api.get('/alerts'),
  create: (data: { stock_id: number; type: string; value: number }) =>
    api.post('/alerts', data),
  toggle: (id: number, is_active: boolean) => api.patch(`/alerts/${id}`, { is_active }),
  delete: (id: number) => api.delete(`/alerts/${id}`),
};

// 차트 / KIS API
export const chartApi = {
  getConfig: () => api.get('/chart/config'),
  getFormConfig: () => api.get('/chart/config/form'),
  saveConfig: (data: Record<string, any>) => api.post('/chart/config', data),
  getCandle: (ticker: string, params?: { period?: string; startDate?: string; endDate?: string }) =>
    api.get(`/chart/candle/${ticker}`, { params }),
  getBalance: () => api.get('/chart/balance'),
  getMarketContext: () => api.get('/chart/market-context'),
  importBalance: () => api.post('/chart/balance/import'),
  getQuoteBook: (ticker: string, market: string = 'KRX') =>
    api.get(`/chart/quote-book/${ticker}`, { params: { market } }),
};

// 기술적 분석 API
export const analysisApi = {
  getAnalysis: (ticker: string) => api.get(`/analysis/${ticker}`),
  getDecision: (ticker: string) => api.post(`/analysis/${ticker}/decision`),
  getOllamaStatus: () => api.get('/analysis/ollama/status'),
  getOllamaModels: () => api.get('/analysis/ollama/models'),
  pullOllamaModel: (model: string) => api.post('/analysis/ollama/pull', { model }, { responseType: 'text' }),
  deleteOllamaModel: (name: string) => api.delete(`/analysis/ollama/models/${encodeURIComponent(name)}`),
  getNews: (ticker: string, refresh?: boolean) => api.get(`/analysis/${ticker}/news`, { params: { refresh } }),
  getSignals: (ticker: string) => api.get(`/analysis/${ticker}/signals`),
};

// 추천 종목 API
export const recommendationsApi = {
  getAll: (params?: { market?: string; status?: string }) => api.get('/recommendations', { params }),
  create: (data: { ticker: string; name: string; market?: string; source?: string; reason?: string; signal_type?: string; confidence?: number }) =>
    api.post('/recommendations', data),
  updateStatus: (id: number, status: string) => api.patch(`/recommendations/${id}`, { status }),
  delete: (id: number) => api.delete(`/recommendations/${id}`),
  addToWatchlist: (id: number) => api.post(`/recommendations/${id}/watch`),
};

// 관심종목 API
export const watchlistApi = {
  getAll: (params?: { market?: string }) => api.get('/watchlist', { params }),
  add: (data: { stock_id: number; market?: string; notes?: string; auto_trade_enabled?: boolean }) =>
    api.post('/watchlist', data),
  update: (id: number, data: { auto_trade_enabled?: boolean; notes?: string }) =>
    api.patch(`/watchlist/${id}`, data),
  delete: (id: number) => api.delete(`/watchlist/${id}`),
};

// 알림 API (시스템 알림)
export const notificationsApi = {
  getAll: (params?: { limit?: number; offset?: number }) => api.get('/notifications', { params }),
  getUnreadCount: () => api.get('/notifications/unread-count'),
  markAsRead: (id: number) => api.patch(`/notifications/${id}/read`),
  markAllAsRead: () => api.post('/notifications/read-all'),
  delete: (id: number) => api.delete(`/notifications/${id}`),
  /** v4.7.1: 모든 알림 일괄 삭제 */
  deleteAll: () => api.delete('/notifications/all'),
};

// 스케줄러 API
export const schedulerApi = {
  getStatus: () => api.get('/scheduler/status'),
};

// 피드백 / 성과 분석 API
export const feedbackApi = {
  getPerformance: (params?: { market?: string; days?: number }) => api.get('/feedback/performance', { params }),
  getAccuracy: (params?: { days?: number }) => api.get('/feedback/accuracy', { params }),
  getWeights: () => api.get('/feedback/weights'),
  optimizeWeights: () => api.post('/feedback/weights/optimize'),
  resetWeights: () => api.post('/feedback/weights/reset'),
  getWeightsHistory: (params?: { limit?: number }) => api.get('/feedback/weights/history', { params }),
  runBacktest: (data: any) => api.post('/feedback/backtest', data),
  getBacktestList: (params?: { limit?: number }) => api.get('/feedback/backtest', { params }),
  getBacktestDetail: (id: number) => api.get(`/feedback/backtest/${id}`),
  getWeeklyReports: (params?: { limit?: number }) => api.get('/feedback/weekly-reports', { params }),
  runWeekendLearning: () => api.post('/feedback/run-weekend-learning'),
  evaluatePerformance: () => api.post('/feedback/evaluate-performance'),
  backfillUntracked: () => api.post('/feedback/backfill-untracked'),
  backupConfig: () => api.get('/feedback/config/backup'),
  restoreConfig: (data: any) => api.post('/feedback/config/restore', data),
  exportStrategy: () => api.get('/feedback/strategy/export'),
  importStrategy: (data: any) => api.post('/feedback/strategy/import', data),
  getLoraStatus: () => api.get('/feedback/lora/status'),
  exportLora: () => api.get('/feedback/lora/export'),
};

// 버전 / 업데이트 API
export const versionApi = {
  check: () => api.get('/version'),
  update: async () => {
    const { data } = await api.get('/update-token');
    return api.post('/update', {}, {
      headers: { 'x-update-token': data.token },
    });
  },
};

// 매매 원칙 API
export const tradingRulesApi = {
  getAll: () => api.get('/trading-rules'),
  update: (ruleId: string, data: { is_enabled?: boolean; params_json?: string }) =>
    api.patch(`/trading-rules/${ruleId}`, data),
  getHistory: (limit = 50) => api.get('/trading-rules/history', { params: { limit } }),
};

// 시스템 이벤트 API
export const systemEventsApi = {
  getAll: (params?: { limit?: number; unresolved?: boolean }) => api.get('/system-events', { params }),
  getCounts: () => api.get('/system-events/counts'),
  resolve: (id: number, resolution?: string) => api.post(`/system-events/${id}/resolve`, { resolution }),
  /** v4.7.1: 단일 이벤트 삭제 */
  delete: (id: number) => api.delete(`/system-events/${id}`),
  /** v4.7.1: 전체 이벤트 삭제 (resolved=true 시 해결된 것만) */
  deleteAll: (onlyResolved = false) =>
    onlyResolved
      ? api.delete('/system-events/all', { params: { resolved: true } })
      : api.delete('/system-events/all'),
};

// NAS 동기화 API
export const nasSyncApi = {
  getStatus: () => api.get('/nas-sync/status'),
  /** NAS 동기화: 외부/공유 저장소용 — API 키 마스킹 */
  run: () => api.post('/nas-sync/run'),
  /** 로컬 백업: brew upgrade 후 복구를 위해 API 키 포함 */
  backup: () => api.post('/nas-sync/backup'),
  validate: (path: string) => api.post('/nas-sync/validate', { path }),
};

// 히트맵 API
export const paperTradingApi = {
  getHoldings: () => api.get('/paper-trading/holdings'),
  getSummary: () => api.get('/paper-trading/summary'),
  getHistory: () => api.get('/paper-trading/history'),
  sell: (stockId: number, currentPrice?: number) =>
    api.post(`/paper-trading/sell/${stockId}`, currentPrice ? { currentPrice } : {}),
};

export const heatmapApi = {
  getPortfolio: () => api.get('/heatmap/portfolio'),
  getMarket: (market: 'KRX' | 'US') => api.get('/heatmap/market', { params: { market } }),
  getRotation: (market: 'KRX' | 'US') => api.get('/heatmap/rotation', { params: { market } }),
};

export default api;
