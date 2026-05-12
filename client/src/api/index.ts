import axios from 'axios';
import type { AxiosError } from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// ─── Global error reporting ─────────────────────────────────
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
      if (!status || status >= 500) {
        toastReporter(extractErrorMessage(error as AxiosError<{ error?: string }>));
      }
    }
    return Promise.reject(error);
  },
);

// 종목
export const stocksApi = {
  getAll: () => api.get('/stocks'),
  get: (id: number) => api.get(`/stocks/${id}`),
  create: (data: { ticker: string; name: string; market?: string; sector?: string }) =>
    api.post('/stocks', data),
  update: (id: number, data: Partial<{ ticker: string; name: string; market: string; sector: string }>) =>
    api.put(`/stocks/${id}`, data),
  delete: (id: number) => api.delete(`/stocks/${id}`),
};

// 거래
export const transactionsApi = {
  getAll: (params?: { stock_id?: number; type?: string; limit?: number; offset?: number }) =>
    api.get('/transactions', { params }),
  create: (data: { stock_id: number; type: 'BUY' | 'SELL'; quantity: number; price: number; fee?: number; date: string; memo?: string }) =>
    api.post('/transactions', data),
  delete: (id: number) => api.delete(`/transactions/${id}`),
};

// 포트폴리오
export const portfolioApi = {
  getSummary: () => api.get('/portfolio/summary'),
  getHistory: () => api.get('/portfolio/history'),
};

// 차트 / KIS
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

// 기술적 분석 + 뉴스
export const analysisApi = {
  getAnalysis: (ticker: string) => api.get(`/analysis/${ticker}`),
  getLlmStatus: () => api.get('/analysis/llm/status'),
  getLlmModels: () => api.get('/analysis/llm/models'),
  getNews: (ticker: string, refresh?: boolean) => api.get(`/analysis/${ticker}/news`, { params: { refresh } }),
};

// 감시대상 (자동/수동 통합)
export const watchTargetsApi = {
  getAll: (source?: 'auto' | 'manual') => api.get('/watch-targets', { params: source ? { source } : {} }),
  addManual: (data: { ticker: string; name: string; sector?: string; reason?: string }) =>
    api.post('/watch-targets/manual', data),
  remove: (id: number) => api.delete(`/watch-targets/${id}`),
  rebuildAuto: () => api.post('/watch-targets/auto/rebuild'),
};

// Top 10 시총 (v5.5.0)
export const topMarketCapApi = {
  get: (refresh?: boolean) => api.get('/top-market-cap', { params: refresh ? { refresh: 1 } : {} }),
  rebalance: (reason?: string) => api.post('/top-market-cap/rebalance', { reason }),
};

// 지정가 대기 주문
export const reservedOrdersApi = {
  getAll: () => api.get('/reserved-orders'),
  create: (data: {
    ticker: string;
    name?: string;
    orderType: 'BUY' | 'SELL';
    targetPrice: number;
    condition: 'BELOW' | 'ABOVE';
    quantity?: number;
    reason?: string;
    expiresAt?: string | null;
  }) => api.post('/reserved-orders', data),
  cancel: (id: number) => api.delete(`/reserved-orders/${id}`),
};

// 시스템 알림
export const notificationsApi = {
  getAll: (params?: { limit?: number; offset?: number }) => api.get('/notifications', { params }),
  getUnreadCount: () => api.get('/notifications/unread-count'),
  markAsRead: (id: number) => api.patch(`/notifications/${id}/read`),
  markAllAsRead: () => api.post('/notifications/read-all'),
  delete: (id: number) => api.delete(`/notifications/${id}`),
  deleteAll: () => api.delete('/notifications/all'),
};

// 스케줄러
export const schedulerApi = {
  getStatus: () => api.get('/scheduler/status'),
};

// 시스템 이벤트
export const systemEventsApi = {
  getAll: (params?: { limit?: number; unresolved?: boolean }) => api.get('/system-events', { params }),
  getCounts: () => api.get('/system-events/counts'),
  resolve: (id: number, resolution?: string) => api.post(`/system-events/${id}/resolve`, { resolution }),
  delete: (id: number) => api.delete(`/system-events/${id}`),
  deleteAll: (onlyResolved = false) =>
    onlyResolved
      ? api.delete('/system-events/all', { params: { resolved: true } })
      : api.delete('/system-events/all'),
};

// 버전
export const versionApi = {
  check: () => api.get('/version'),
  update: async () => {
    const { data } = await api.get('/update-token');
    return api.post('/update', {}, {
      headers: { 'x-update-token': data.token },
    });
  },
};

export default api;
