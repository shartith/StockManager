import { defineStore } from 'pinia';
import { ref } from 'vue';
import { portfolioApi, stocksApi } from '@/api';

export const usePortfolioStore = defineStore('portfolio', () => {
  const summary = ref<any>(null);
  const stocks = ref<any[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchSummary() {
    loading.value = true;
    error.value = null;
    try {
      const { data } = await portfolioApi.getSummary();
      summary.value = data;
    } catch (err: any) {
      error.value = err.response?.data?.error || '포트폴리오 조회 실패';
    } finally {
      loading.value = false;
    }
  }

  async function fetchStocks() {
    try {
      const { data } = await stocksApi.getAll();
      stocks.value = data;
    } catch {
      // silent
    }
  }

  return { summary, stocks, loading, error, fetchSummary, fetchStocks };
});
