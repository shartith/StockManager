<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-txt-primary">관심 종목</h2>
      <div class="flex gap-2 items-center">
        <!-- 스케줄러 상태 -->
        <span class="text-xs px-3 py-1 rounded-full font-medium"
          :class="schedulerStatus.active ? 'bg-green-50 text-green-700' : 'bg-surface-3 text-txt-secondary'">
          {{ schedulerStatus.active ? `스케줄러 활성 (${schedulerStatus.taskCount}개)` : '스케줄러 비활성' }}
        </span>
      </div>
    </div>

    <!-- 시장 필터 -->
    <div class="flex gap-1 mb-6 bg-surface-3 rounded-lg p-1 w-fit">
      <button v-for="m in markets" :key="m.value" @click="selectedMarket = m.value"
        class="px-4 py-2 rounded text-sm font-medium transition-colors"
        :class="selectedMarket === m.value ? 'bg-surface-1 text-txt-primary shadow-sm' : 'text-txt-secondary hover:text-txt-primary'">
        {{ m.label }}
      </button>
    </div>

    <!-- 관심종목 목록 -->
    <div v-if="loading" class="text-txt-tertiary text-sm">로딩 중...</div>
    <div v-else-if="filteredList.length === 0" class="text-center py-16 text-txt-tertiary">
      <p class="text-4xl mb-3">⭐</p>
      <p>관심 종목이 없습니다</p>
      <p class="text-xs mt-1">추천 종목에서 추가하거나 직접 등록하세요</p>
    </div>
    <div v-else class="bg-surface-1 rounded-xl border border-border shadow-sm overflow-hidden">
      <table class="w-full text-sm table-fixed">
        <colgroup>
          <col style="width: 160px" /><!-- 종목 -->
          <col style="width: 72px" /><!-- 시장 -->
          <col /><!-- 메모 (남은 공간) -->
          <col style="width: 80px" /><!-- 자동매매 -->
          <col style="width: 80px" /><!-- 최근 신호 -->
          <col style="width: 72px" /><!-- 분석 -->
          <col style="width: 60px" /><!-- 관리 -->
        </colgroup>
        <thead class="bg-surface-2 text-txt-secondary">
          <tr>
            <th class="text-left px-4 py-3 whitespace-nowrap">종목</th>
            <th class="text-center px-4 py-3 whitespace-nowrap">시장</th>
            <th class="text-left px-4 py-3 whitespace-nowrap">메모</th>
            <th class="text-center px-4 py-3 whitespace-nowrap">자동매매</th>
            <th class="text-center px-4 py-3 whitespace-nowrap">신호</th>
            <th class="text-center px-4 py-3 whitespace-nowrap">분석</th>
            <th class="text-center px-4 py-3 whitespace-nowrap">관리</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pagedList" :key="item.id" class="border-t border-border-subtle hover:bg-surface-2">
            <td class="px-4 py-3">
              <div class="font-medium text-txt-primary truncate">{{ item.ticker }}</div>
              <div class="text-xs text-txt-tertiary truncate">{{ item.name }}</div>
            </td>
            <td class="text-center px-4 py-3">
              <span class="text-xs px-2 py-0.5 rounded-full"
                :class="item.market === 'KRX' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'">
                {{ item.market }}
              </span>
            </td>
            <td class="px-4 py-3 text-xs text-txt-secondary truncate" :title="item.notes">{{ item.notes || '-' }}</td>
            <td class="text-center px-4 py-3">
              <label class="cursor-pointer">
                <div class="relative inline-block">
                  <input type="checkbox" :checked="!!item.auto_trade_enabled" @change="toggleAutoTrade(item)" class="sr-only" />
                  <div class="w-9 h-5 rounded-full transition-colors" :class="item.auto_trade_enabled ? 'bg-primary' : 'bg-surface-3'"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="item.auto_trade_enabled ? 'translate-x-4' : 'translate-x-0'"></div>
                </div>
              </label>
            </td>
            <td class="text-center px-4 py-3">
              <template v-if="item.latestSignal">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                  :class="item.latestSignal === 'BUY' ? 'bg-red-50 text-red-700' : item.latestSignal === 'SELL' ? 'bg-blue-50 text-blue-700' : 'bg-surface-3 text-txt-secondary'">
                  {{ item.latestSignal === 'BUY' ? '매수' : item.latestSignal === 'SELL' ? '매도' : '관망' }}
                </span>
                <p v-if="item.latestConfidence" class="text-xs text-txt-tertiary mt-0.5">{{ Math.round(item.latestConfidence) }}%</p>
              </template>
              <span v-else class="text-xs text-txt-tertiary">-</span>
            </td>
            <td class="text-center px-4 py-3">
              <div class="flex gap-1 justify-center">
                <button @click="openChart(item.ticker)"
                  class="text-xs px-3 py-1.5 bg-surface-2 text-txt-primary rounded hover:bg-surface-3 transition whitespace-nowrap">
                  차트
                </button>
                <button @click="analyze(item)" :disabled="analyzing === item.id"
                  class="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 disabled:opacity-50 transition whitespace-nowrap">
                  {{ analyzing === item.id ? '분석중...' : '분석' }}
                </button>
              </div>
            </td>
            <td class="text-center px-4 py-3">
              <button @click="removeWatch(item.id)" class="text-xs px-3 py-1.5 text-red-500 hover:text-red-700 whitespace-nowrap">삭제</button>
            </td>
          </tr>
        </tbody>
      </table>
      <PaginationBar v-model:page="wlPage" v-model:pageSize="wlPageSize" :total="filteredList.length" />
    </div>

    <!-- 분석 결과 모달 -->
    <div v-if="analysisResult" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" @click.self="analysisResult = null">
      <div class="bg-surface-1 rounded-xl shadow-lg p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-txt-primary">{{ analysisResult.name }} ({{ analysisResult.ticker }}) 분석</h3>
          <button @click="analysisResult = null" class="text-txt-tertiary hover:text-txt-secondary">✕</button>
        </div>

        <!-- 기술 지표 -->
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">RSI (14)</p>
            <p class="font-bold" :class="(analysisResult.indicators.rsi14 ?? 50) < 30 ? 'text-profit' : (analysisResult.indicators.rsi14 ?? 50) > 70 ? 'text-loss' : 'text-txt-primary'">
              {{ analysisResult.indicators.rsi14 ?? 'N/A' }}
            </p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">MACD</p>
            <p class="font-bold text-txt-primary">{{ analysisResult.indicators.macd ?? 'N/A' }}</p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">SMA(20)</p>
            <p class="font-bold text-txt-primary">{{ analysisResult.indicators.sma20?.toLocaleString() ?? 'N/A' }}</p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">볼린저 중심</p>
            <p class="font-bold text-txt-primary">{{ analysisResult.indicators.bollingerMiddle?.toLocaleString() ?? 'N/A' }}</p>
          </div>
        </div>

        <!-- 종합 신호 -->
        <div class="p-4 rounded-lg mb-4"
          :class="analysisResult.indicators.signal === 'BUY' ? 'bg-red-50 border border-red-200' : analysisResult.indicators.signal === 'SELL' ? 'bg-blue-50 border border-blue-200' : 'bg-surface-2 border border-border'">
          <p class="text-sm font-semibold mb-1"
            :class="analysisResult.indicators.signal === 'BUY' ? 'text-red-700' : analysisResult.indicators.signal === 'SELL' ? 'text-blue-700' : 'text-txt-primary'">
            종합 신호: {{ analysisResult.indicators.signal === 'BUY' ? '매수' : analysisResult.indicators.signal === 'SELL' ? '매도' : '관망' }}
          </p>
          <ul class="text-xs text-txt-secondary space-y-0.5">
            <li v-for="r in analysisResult.indicators.signalReasons" :key="r">• {{ r }}</li>
          </ul>
        </div>
      </div>
    </div>
    <!-- 차트 모달 -->
    <ChartModal :visible="chartModalVisible" :ticker="chartModalTicker" @close="chartModalVisible = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, defineAsyncComponent } from 'vue';
import { watchlistApi, analysisApi, schedulerApi } from '@/api';
import { usePagination } from '@/composables/usePagination';
import PaginationBar from '@/components/PaginationBar.vue';
// v4.7.0: lazy-load ChartModal (lightweight-charts ~170KB)
const ChartModal = defineAsyncComponent(() => import('@/components/ChartModal.vue'));

const chartModalVisible = ref(false);
const chartModalTicker = ref('');
function openChart(ticker: string) {
  chartModalTicker.value = ticker;
  chartModalVisible.value = true;
}

const loading = ref(false);
const watchlist = ref<any[]>([]);
const selectedMarket = ref('ALL');
const analyzing = ref<number | null>(null);
const analysisResult = ref<any>(null);
const schedulerStatus = ref({ active: false, taskCount: 0 });

const markets = [
  { label: '전체', value: 'ALL' },
  { label: '🇰🇷 KRX', value: 'KRX' },
  { label: '🇺🇸 NYSE', value: 'NYSE' },
  { label: '🇺🇸 NASDAQ', value: 'NASDAQ' },
];

const filteredList = computed(() => {
  if (selectedMarket.value === 'ALL') return watchlist.value;
  return watchlist.value.filter(w => w.market === selectedMarket.value || w.stock_market === selectedMarket.value);
});

const { page: wlPage, pageSize: wlPageSize, paged: pagedList } = usePagination(filteredList, 50);
watch(selectedMarket, () => { wlPage.value = 1; });

async function fetchWatchlist() {
  loading.value = true;
  try {
    const { data } = await watchlistApi.getAll();
    watchlist.value = data;
  } catch { /* */ }
  finally { loading.value = false; }
}

async function fetchSchedulerStatus() {
  try {
    const { data } = await schedulerApi.getStatus();
    schedulerStatus.value = data;
  } catch { /* */ }
}

async function toggleAutoTrade(item: any) {
  try {
    await watchlistApi.update(item.id, { auto_trade_enabled: !item.auto_trade_enabled });
    await fetchWatchlist();
  } catch { /* */ }
}

async function removeWatch(id: number) {
  try {
    await watchlistApi.delete(id);
    await fetchWatchlist();
  } catch { /* */ }
}

async function analyze(item: any) {
  analyzing.value = item.id;
  try {
    const { data } = await analysisApi.getAnalysis(item.ticker);
    analysisResult.value = data;
  } catch { /* */ }
  finally { analyzing.value = null; }
}

onMounted(() => {
  fetchWatchlist();
  fetchSchedulerStatus();
});
</script>
