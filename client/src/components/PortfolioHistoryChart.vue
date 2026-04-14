<template>
  <div class="w-full">
    <div v-if="loading" class="flex items-center justify-center h-64 text-txt-tertiary text-sm">로딩 중...</div>
    <div v-else-if="data.length === 0" class="flex items-center justify-center h-64 text-txt-tertiary text-sm">
      거래 내역이 없습니다
    </div>
    <Line v-else :data="chartData" :options="chartOptions" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Line } from 'vue-chartjs';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { portfolioApi } from '@/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

interface HistoryRow {
  date: string;
  buy_total: number;
  sell_total: number;
  fees: number;
}

const data = ref<HistoryRow[]>([]);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data: rows } = await portfolioApi.getHistory();
    data.value = rows;
  } catch {
    data.value = [];
  }
  loading.value = false;
}

onMounted(load);

// 누적 순투자 = Σ(buy_total - sell_total) — 이 값이 양수면 "누적 매수 잔량".
// 수수료 누적도 함께 시각화.
const chartData = computed(() => {
  let cumNet = 0;
  let cumFees = 0;
  const labels: string[] = [];
  const netSeries: number[] = [];
  const feeSeries: number[] = [];

  for (const row of data.value) {
    cumNet += (row.buy_total || 0) - (row.sell_total || 0);
    cumFees += row.fees || 0;
    labels.push(row.date);
    netSeries.push(Math.round(cumNet));
    feeSeries.push(Math.round(cumFees));
  }

  return {
    labels,
    datasets: [
      {
        label: '누적 순투자 (원)',
        data: netSeries,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      },
      {
        label: '누적 수수료 (원)',
        data: feeSeries,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.05)',
        fill: false,
        tension: 0.3,
        pointRadius: 1,
        yAxisID: 'y1',
      },
    ],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { position: 'top' as const, labels: { font: { size: 11 } } },
    tooltip: {
      callbacks: {
        label: (ctx: any) => {
          const v = Math.round(ctx.parsed.y).toLocaleString();
          return `${ctx.dataset.label}: ${v}원`;
        },
      },
    },
  },
  scales: {
    y: {
      position: 'left' as const,
      ticks: {
        font: { size: 10 },
        callback: (v: any) => (v / 1_000_000).toFixed(1) + 'M',
      },
    },
    y1: {
      position: 'right' as const,
      grid: { drawOnChartArea: false },
      ticks: {
        font: { size: 10 },
        callback: (v: any) => (v / 1000).toFixed(0) + 'K',
      },
    },
    x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 45 } },
  },
};
</script>
