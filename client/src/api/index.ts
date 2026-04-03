import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

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
  update: () => api.post('/update'),
};

// 시스템 이벤트 API
export const systemEventsApi = {
  getAll: (params?: { limit?: number; unresolved?: boolean }) => api.get('/system-events', { params }),
  getCounts: () => api.get('/system-events/counts'),
  resolve: (id: number, resolution?: string) => api.post(`/system-events/${id}/resolve`, { resolution }),
};

export default api;
