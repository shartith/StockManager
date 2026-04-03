<template>
  <div v-if="visible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="close">
    <div class="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-4xl mx-4 overflow-hidden">
      <!-- 헤더 -->
      <div class="flex items-center justify-between px-5 py-3 border-b border-slate-200">
        <div>
          <span class="font-bold text-slate-800 dark:text-slate-200">{{ chartData?.name || ticker }}</span>
          <span class="text-xs text-slate-400 ml-2 font-mono">{{ ticker }}</span>
          <template v-if="chartData">
            <span class="ml-3 text-lg font-bold" :class="chartData.changeRate >= 0 ? 'text-red-600' : 'text-blue-600'">
              {{ formatNum(chartData.currentPrice) }}
            </span>
            <span class="ml-1 text-xs" :class="chartData.changeRate >= 0 ? 'text-red-500' : 'text-blue-500'">
              {{ chartData.changeRate >= 0 ? '+' : '' }}{{ chartData.changeRate }}%
            </span>
          </template>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex bg-slate-100 rounded p-0.5">
            <button v-for="p in periods" :key="p.v" @click="changePeriod(p.v)"
              class="px-2.5 py-1 rounded text-xs font-medium transition"
              :class="period === p.v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'">
              {{ p.l }}
            </button>
          </div>
          <button @click="close" class="text-slate-400 hover:text-slate-600 text-xl ml-2">&times;</button>
        </div>
      </div>

      <!-- 차트 -->
      <div v-if="loading" class="flex items-center justify-center h-96 text-slate-400 text-sm">차트 로딩 중...</div>
      <div v-else-if="error" class="flex items-center justify-center h-96 text-red-500 text-sm">{{ error }}</div>
      <template v-else>
        <div ref="chartEl" style="height: 360px;"></div>
        <div ref="volEl" style="height: 80px;" class="border-t border-slate-100"></div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { createChart, IChartApi, CandlestickSeries, HistogramSeries, ColorType } from 'lightweight-charts';
import { chartApi } from '@/api';

const props = defineProps<{ visible: boolean; ticker: string }>();
const emit = defineEmits(['close']);

const periods = [{ v: 'D', l: '일' }, { v: 'W', l: '주' }, { v: 'M', l: '월' }];
const period = ref('D');
const loading = ref(false);
const error = ref('');
const chartData = ref<any>(null);
const chartEl = ref<HTMLElement>();
const volEl = ref<HTMLElement>();
let chart: IChartApi | null = null;

function formatNum(n: number) { return n?.toLocaleString() ?? '-'; }
function close() { emit('close'); }

function changePeriod(p: string) {
  period.value = p;
  fetchChart();
}

async function fetchChart() {
  if (!props.ticker) return;
  loading.value = true;
  error.value = '';
  chartData.value = null;

  try {
    const { data } = await chartApi.getCandle(props.ticker, { period: period.value });
    chartData.value = data;
    await nextTick();
    renderChart(data.candles);
  } catch (err: any) {
    error.value = err.response?.data?.error || '차트 조회 실패';
  } finally {
    loading.value = false;
  }
}

function renderChart(candles: any[]) {
  if (!chartEl.value || !volEl.value) return;
  if (chart) { chart.remove(); chart = null; }

  const opts = {
    layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#64748b', fontSize: 11 },
    grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
    rightPriceScale: { borderColor: '#e2e8f0' },
    timeScale: { borderColor: '#e2e8f0' },
    crosshair: { mode: 1 as any },
  };

  chart = createChart(chartEl.value, { ...opts, width: chartEl.value.clientWidth, height: 360 });
  const cs = chart.addSeries(CandlestickSeries, {
    upColor: '#ef4444', downColor: '#3b82f6',
    borderUpColor: '#ef4444', borderDownColor: '#3b82f6',
    wickUpColor: '#ef4444', wickDownColor: '#3b82f6',
  });
  cs.setData(candles);

  const vc = createChart(volEl.value, { ...opts, width: volEl.value.clientWidth, height: 80, timeScale: { visible: false } });
  const vs = vc.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
  vs.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
  vs.setData(candles.map((c: any) => ({
    time: c.time, value: c.volume,
    color: c.close >= c.open ? 'rgba(239,68,68,0.5)' : 'rgba(59,130,246,0.5)',
  })));

  chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) vc.timeScale().setVisibleLogicalRange(r); });
  vc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && chart) chart.timeScale().setVisibleLogicalRange(r); });
  chart.timeScale().fitContent();
}

watch(() => props.visible, (v) => { if (v && props.ticker) fetchChart(); });
watch(() => props.ticker, () => { if (props.visible) fetchChart(); });

onUnmounted(() => { if (chart) chart.remove(); });
</script>
