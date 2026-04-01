<template>
  <div>
    <h2 class="text-2xl font-bold text-slate-800 mb-6">주식 차트</h2>

    <!-- API 미설정 경고 -->
    <div v-if="!apiConfigured" class="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-6 flex items-start gap-3">
      <span class="text-xl">⚠️</span>
      <div>
        <p class="text-sm font-medium text-amber-800">KIS API가 설정되지 않았습니다</p>
        <p class="text-xs text-amber-600 mt-1">
          <router-link to="/settings" class="underline font-medium">설정 페이지</router-link>에서 한국투자증권 App Key와 App Secret을 입력하면 실시간 캔들 차트를 볼 수 있습니다.
        </p>
      </div>
    </div>

    <!-- 검색 바 -->
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4">
      <div class="flex gap-3">
        <div class="flex-1 relative">
          <input
            v-model="searchTicker"
            @keyup.enter="loadChart"
            type="text"
            placeholder="종목코드 입력 (예: 005930, 035720)"
            class="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>
        <!-- 기간 선택 -->
        <div class="flex bg-slate-100 rounded-lg p-1">
          <button
            v-for="p in periods"
            :key="p.value"
            @click="selectPeriod(p.value)"
            class="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            :class="period === p.value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'"
          >
            {{ p.label }}
          </button>
        </div>
        <button
          @click="loadChart"
          :disabled="loading || !searchTicker.trim()"
          class="bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {{ loading ? '조회 중...' : '조회' }}
        </button>
      </div>

      <!-- 보유 종목 퀵 버튼 -->
      <div v-if="holdingTickers.length > 0" class="flex gap-2 mt-3 flex-wrap">
        <span class="text-xs text-slate-400">보유 종목:</span>
        <button
          v-for="t in holdingTickers"
          :key="t"
          @click="quickLoad(t)"
          class="text-xs px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded transition"
        >
          {{ t }}
        </button>
      </div>
    </div>

    <!-- 에러 메시지 -->
    <div v-if="error" class="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
      {{ error }}
    </div>

    <!-- 차트 영역 -->
    <div v-if="chartData" class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <!-- 종목 헤더 -->
      <div class="p-5 border-b border-slate-100">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-lg font-bold text-slate-800">
              {{ chartData.name }} <span class="text-slate-400 font-normal text-sm ml-2">{{ chartData.ticker }}</span>
            </h3>
            <div class="flex items-center gap-3 mt-1">
              <span class="text-2xl font-bold" :class="chartData.changeRate >= 0 ? 'text-red-600' : 'text-blue-600'">
                {{ formatNumber(chartData.currentPrice) }}원
              </span>
              <span class="text-sm font-medium px-2 py-0.5 rounded"
                :class="chartData.changeRate >= 0 ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'">
                {{ chartData.changeRate >= 0 ? '▲' : '▼' }}
                {{ Math.abs(chartData.changeAmount) }}원
                ({{ chartData.changeRate >= 0 ? '+' : '' }}{{ chartData.changeRate }}%)
              </span>
            </div>
          </div>
          <div class="text-xs text-slate-400">
            {{ period === 'D' ? '일봉' : period === 'W' ? '주봉' : period === 'M' ? '월봉' : '연봉' }}
            · {{ chartData.candles.length }}개 데이터
          </div>
        </div>
      </div>

      <!-- 캔들스틱 차트 -->
      <div ref="chartContainer" class="w-full" style="height: 440px;"></div>

      <!-- 거래량 차트 -->
      <div ref="volumeContainer" class="w-full border-t border-slate-100" style="height: 120px;"></div>
    </div>

    <!-- 초기 상태 -->
    <div v-else-if="!loading && !error" class="text-center py-20 text-slate-400">
      <p class="text-4xl mb-4">📈</p>
      <p class="text-lg font-medium">종목코드를 입력하고 조회하세요</p>
      <p class="text-sm mt-2">예: 005930 (삼성전자), 035720 (카카오), 000660 (SK하이닉스)</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { createChart, IChartApi, ISeriesApi, CandlestickSeries, HistogramSeries, ColorType } from 'lightweight-charts';
import { chartApi, stocksApi } from '@/api';

const searchTicker = ref('');
const period = ref('D');
const loading = ref(false);
const error = ref('');
const chartData = ref<any>(null);
const apiConfigured = ref(true);
const holdingTickers = ref<string[]>([]);

const chartContainer = ref<HTMLElement>();
const volumeContainer = ref<HTMLElement>();
let chart: IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;
let volumeSeries: ISeriesApi<'Histogram'> | null = null;

const periods = [
  { label: '일', value: 'D' },
  { label: '주', value: 'W' },
  { label: '월', value: 'M' },
  { label: '년', value: 'Y' },
];

function formatNumber(n: number) {
  return new Intl.NumberFormat('ko-KR').format(n);
}

function selectPeriod(p: string) {
  period.value = p;
  if (chartData.value) loadChart();
}

function quickLoad(ticker: string) {
  searchTicker.value = ticker;
  loadChart();
}

async function loadChart() {
  const ticker = searchTicker.value.trim().toUpperCase();
  if (!ticker) return;

  loading.value = true;
  error.value = '';
  chartData.value = null;

  try {
    const { data } = await chartApi.getCandle(ticker, { period: period.value });
    chartData.value = data;

    await nextTick();
    renderChart(data.candles);
  } catch (err: any) {
    const msg = err.response?.data?.error || '차트 데이터 조회 실패';
    if (err.response?.data?.code === 'NO_CONFIG') {
      apiConfigured.value = false;
    }
    error.value = msg;
  } finally {
    loading.value = false;
  }
}

function renderChart(candles: any[]) {
  if (!chartContainer.value || !volumeContainer.value) return;

  // 기존 차트 제거
  if (chart) {
    chart.remove();
    chart = null;
  }

  const chartOptions = {
    layout: {
      background: { type: ColorType.Solid, color: '#ffffff' },
      textColor: '#64748b',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: '#f1f5f9' },
      horzLines: { color: '#f1f5f9' },
    },
    rightPriceScale: {
      borderColor: '#e2e8f0',
    },
    timeScale: {
      borderColor: '#e2e8f0',
      timeVisible: true,
    },
    crosshair: {
      mode: 1,
    },
  };

  // 캔들 차트
  chart = createChart(chartContainer.value, {
    ...chartOptions,
    width: chartContainer.value.clientWidth,
    height: 440,
  });

  candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#ef4444',
    downColor: '#3b82f6',
    borderUpColor: '#ef4444',
    borderDownColor: '#3b82f6',
    wickUpColor: '#ef4444',
    wickDownColor: '#3b82f6',
  });
  candleSeries.setData(candles);

  // 거래량 차트 (별도)
  const volChart = createChart(volumeContainer.value, {
    ...chartOptions,
    width: volumeContainer.value.clientWidth,
    height: 120,
    timeScale: { visible: false },
  });

  volumeSeries = volChart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: '',
  });
  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.1, bottom: 0 },
  });

  const volumeData = candles.map(c => ({
    time: c.time,
    value: c.volume,
    color: c.close >= c.open ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.5)',
  }));
  volumeSeries.setData(volumeData);

  // 차트 크기 동기화
  chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range) volChart.timeScale().setVisibleLogicalRange(range);
  });
  volChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range) chart!.timeScale().setVisibleLogicalRange(range);
  });

  chart.timeScale().fitContent();
}

// 반응형 리사이즈
function handleResize() {
  if (chart && chartContainer.value) {
    chart.applyOptions({ width: chartContainer.value.clientWidth });
  }
}

async function checkConfig() {
  try {
    const { data } = await chartApi.getConfig();
    apiConfigured.value = data.configured;
  } catch {
    apiConfigured.value = false;
  }
}

async function loadHoldingTickers() {
  try {
    const { data } = await stocksApi.getAll();
    holdingTickers.value = data.map((s: any) => s.ticker);
  } catch {
    // silent
  }
}

onMounted(() => {
  checkConfig();
  loadHoldingTickers();
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  if (chart) chart.remove();
});
</script>
