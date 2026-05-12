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
};

// Top 10 시총
export const topMarketCapApi = {
  get: (refresh?: boolean) => api.get('/top-market-cap', { params: refresh ? { refresh: 1 } : {} }),
  rebalance: (reason?: string) => api.post('/top-market-cap/rebalance', { reason }),
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
