<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-txt-primary">시장 히트맵</h2>
        <p class="text-sm text-txt-tertiary mt-0.5">섹터별 등락률 실시간 현황</p>
      </div>
      <div class="flex items-center gap-2">
        <!-- Stats -->
        <div v-if="currentData" class="flex items-center gap-3 text-xs">
          <span class="text-profit font-medium">&#9650; {{ currentData.advancers }}</span>
          <span class="text-loss font-medium">&#9660; {{ currentData.decliners }}</span>
          <span class="text-txt-tertiary">{{ currentData.totalStocks }}종목</span>
        </div>
        <button @click="refresh" class="p-2 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-surface-2 transition-colors" aria-label="새로고침">
          <svg class="w-5 h-5" :class="{ 'animate-spin': loading }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="flex gap-1 p-1 glass-card mb-6 w-fit">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
        :class="activeTab === tab.key ? 'bg-accent text-white shadow-sm' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-2'">
        {{ tab.label }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && !currentData" class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
    </div>

    <!-- Heatmap -->
    <HeatmapTreemap v-else-if="currentData" :data="currentData" height="calc(100vh - 14rem)"
      @stock-click="openChart" />

    <!-- Last update -->
    <div v-if="currentData" class="mt-3 text-xs text-txt-tertiary text-right">
      마지막 업데이트: {{ formatTime(currentData.updatedAt) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { heatmapApi } from '@/api';
import { useAutoRefresh } from '@/composables/useAutoRefresh';
import HeatmapTreemap from '@/components/HeatmapTreemap.vue';

interface HeatmapData {
  sectors: Array<{
    sector: string;
    stocks: Array<{
      ticker: string;
      name: string;
      sector: string;
      price: number;
      changePercent: number;
      weight: number;
    }>;
  }>;
  advancers: number;
  decliners: number;
  totalStocks: number;
  updatedAt: string;
}

const router = useRouter();

const tabs = [
  { key: 'portfolio', label: '내 포트폴리오' },
  { key: 'KRX', label: 'KRX 시장' },
  { key: 'US', label: 'S&P 500' },
] as const;

type TabKey = typeof tabs[number]['key'];

const activeTab = ref<TabKey>('portfolio');
const currentData = ref<HeatmapData | null>(null);

async function fetchData() {
  try {
    let response;
    if (activeTab.value === 'portfolio') {
      response = await heatmapApi.getPortfolio();
    } else {
      response = await heatmapApi.getMarket(activeTab.value);
    }
    currentData.value = response.data;
  } catch {
    // Error handled silently; currentData remains as-is
  }
}

const { loading, refresh } = useAutoRefresh(fetchData, {
  intervalOverride: 60000,
  immediate: true,
});

watch(activeTab, () => {
  currentData.value = null;
  refresh();
});

function openChart(ticker: string) {
  router.push(`/chart?ticker=${encodeURIComponent(ticker)}`);
}

function formatTime(dt?: string): string {
  if (!dt) return '-';
  const d = new Date(dt.includes('Z') ? dt : dt + 'Z');
  return d.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
</script>
