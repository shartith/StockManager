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
        <div v-if="currentData && !activeTab.startsWith('rotation-')" class="flex items-center gap-3 text-xs">
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
    <div v-if="loading && !currentData && !rotationData" class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
    </div>

    <!-- Heatmap (treemap 모드) -->
    <template v-else-if="activeTab === 'portfolio' || activeTab === 'KRX' || activeTab === 'US'">
      <HeatmapTreemap v-if="currentData" :data="currentData" height="calc(100vh - 14rem)"
        @stock-click="openChart" />
      <div v-if="currentData" class="mt-3 text-xs text-txt-tertiary text-right">
        마지막 업데이트: {{ formatTime(currentData.updatedAt) }}
      </div>
    </template>

    <!-- 섹터 Rotation 뷰 -->
    <template v-else-if="(activeTab === 'rotation-krx' || activeTab === 'rotation-us') && rotationData">
      <!-- Breadth 경고 배너 -->
      <div v-if="rotationData.breadth?.divergenceWarning"
        class="glass-card p-4 mb-4 border-l-4 border-amber-500 bg-amber-500/5">
        <p class="text-sm font-semibold text-amber-600">⚠️ 다이버전스 경고</p>
        <p class="text-xs text-txt-secondary mt-1">{{ rotationData.breadth.divergenceWarning }}</p>
      </div>
      <div v-if="rotationData.breadth?.narrowLeadership"
        class="glass-card p-4 mb-4 border-l-4 border-loss bg-loss/5">
        <p class="text-sm font-semibold text-loss">📉 협소한 리더십</p>
        <p class="text-xs text-txt-secondary mt-1">
          소수 섹터만 상승 중 ({{ rotationData.breadth.sectorLeadership }}/{{ rotationData.breadth.totalSectors }} 섹터 상승) — 장 피로 신호
        </p>
      </div>

      <!-- Breadth 요약 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div class="glass-card p-4">
          <p class="text-xs text-txt-secondary">상승/하락 비율</p>
          <p class="text-2xl font-bold mt-1"
             :class="rotationData.breadth.advanceDeclineRatio >= 1 ? 'text-profit' : 'text-loss'">
            {{ rotationData.breadth.advanceDeclineRatio.toFixed(2) }}
          </p>
        </div>
        <div class="glass-card p-4">
          <p class="text-xs text-txt-secondary">상승 섹터</p>
          <p class="text-2xl font-bold text-txt-primary mt-1">
            {{ rotationData.breadth.sectorLeadership }}
            <span class="text-sm text-txt-tertiary">/ {{ rotationData.breadth.totalSectors }}</span>
          </p>
        </div>
        <div class="glass-card p-4">
          <p class="text-xs text-txt-secondary">강세 섹터 (IN)</p>
          <p class="text-sm font-medium text-profit mt-1">
            {{ rotationData.strongSectors.length ? rotationData.strongSectors.join(', ') : '없음' }}
          </p>
        </div>
      </div>

      <!-- 섹터별 모멘텀 막대 -->
      <div class="glass-card p-5">
        <h3 class="text-sm font-semibold text-txt-primary mb-4">섹터별 상대 강도 (Relative Strength)</h3>
        <div class="space-y-2">
          <div v-for="s in rotationData.sectors" :key="s.sector"
               class="flex items-center gap-3 text-sm">
            <!-- Rotation 신호 배지 -->
            <span class="w-14 text-xs font-medium text-center px-2 py-0.5 rounded flex-shrink-0"
                  :class="s.rotationSignal === 'IN' ? 'bg-profit/10 text-profit' :
                          s.rotationSignal === 'OUT' ? 'bg-loss/10 text-loss' :
                          'bg-surface-3 text-txt-secondary'">
              {{ s.rotationSignal === 'IN' ? '🔥 IN' : s.rotationSignal === 'OUT' ? '❄️ OUT' : '— NEU' }}
            </span>
            <span class="w-24 text-txt-primary font-medium truncate">{{ s.sector }}</span>
            <!-- 막대 -->
            <div class="flex-1 relative h-6 bg-surface-3 rounded overflow-hidden">
              <div class="absolute top-0 h-full transition-all"
                   :class="s.relativeStrength >= 0 ? 'bg-profit/70 left-1/2' : 'bg-loss/70 right-1/2'"
                   :style="{ width: Math.min(Math.abs(s.relativeStrength) / 2, 50) + '%' }">
              </div>
              <div class="absolute top-0 left-1/2 w-px h-full bg-border" />
            </div>
            <span class="w-20 text-right tabular-nums text-xs"
                  :class="s.relativeStrength >= 0 ? 'text-profit' : 'text-loss'">
              {{ s.relativeStrength >= 0 ? '+' : '' }}{{ s.relativeStrength.toFixed(1) }}
            </span>
            <span class="w-16 text-right tabular-nums text-xs text-txt-tertiary">
              {{ (s.breadthRatio * 100).toFixed(0) }}%
            </span>
            <span class="w-12 text-right text-xs text-txt-tertiary">{{ s.stockCount }}</span>
          </div>
        </div>
        <div class="mt-4 pt-3 border-t border-border text-xs text-txt-tertiary">
          <p><strong>Relative Strength</strong>: 시장 평균 대비 섹터 초과 수익률 (-100 ~ +100). <strong>IN</strong>: RS &gt; 25 + 상승비율 &gt; 60%. <strong>OUT</strong>: RS &lt; -25 + 상승비율 &lt; 40%.</p>
        </div>
      </div>

      <div class="mt-3 text-xs text-txt-tertiary text-right">
        마지막 업데이트: {{ formatTime(rotationData.updatedAt) }}
      </div>
    </template>
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
  { key: 'rotation-krx', label: '🔄 KRX 섹터 로테이션' },
  { key: 'rotation-us', label: '🔄 US 섹터 로테이션' },
] as const;

type TabKey = typeof tabs[number]['key'];

interface SectorMomentum {
  sector: string;
  avgChangePercent: number;
  breadthRatio: number;
  relativeStrength: number;
  rotationSignal: 'IN' | 'OUT' | 'NEUTRAL';
  stockCount: number;
}
interface MarketBreadth {
  advanceDeclineRatio: number;
  sectorLeadership: number;
  totalSectors: number;
  narrowLeadership: boolean;
  divergenceWarning: string | null;
}
interface RotationData {
  market: string;
  sectors: SectorMomentum[];
  breadth: MarketBreadth;
  strongSectors: string[];
  weakSectors: string[];
  updatedAt: string;
}

const activeTab = ref<TabKey>('portfolio');
const currentData = ref<HeatmapData | null>(null);
const rotationData = ref<RotationData | null>(null);

async function fetchData() {
  try {
    if (activeTab.value === 'rotation-krx' || activeTab.value === 'rotation-us') {
      const market = activeTab.value === 'rotation-krx' ? 'KRX' : 'US';
      const { data } = await heatmapApi.getRotation(market);
      rotationData.value = data;
      return;
    }
    let response;
    if (activeTab.value === 'portfolio') {
      response = await heatmapApi.getPortfolio();
    } else if (activeTab.value === 'KRX' || activeTab.value === 'US') {
      response = await heatmapApi.getMarket(activeTab.value);
    } else {
      return;
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
  rotationData.value = null;
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
