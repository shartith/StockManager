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
import { portfolioApi, paperTradingApi } from '@/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

interface HistoryRow {
  date: string;
  buy_total: number;
  sell_total: number;
  fees: number;
}

interface PaperRow {
  date: string;
  buy_total: number;  // BUY 합계 (가상)
  sell_total: number; // SELL 합계 (가상)
  pnl_total: number;  // 누적 P&L
}

const data = ref<HistoryRow[]>([]);
const paperData = ref<PaperRow[]>([]);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [realRes, paperRes] = await Promise.all([
      portfolioApi.getHistory(),
      paperTradingApi.getHistory().catch(() => ({ data: [] })),
    ]);
    data.value = realRes.data;
    // 날짜별 paper buy/sell/pnl 집계
    const byDate = new Map<string, PaperRow>();
    for (const p of (paperRes.data || []) as Array<{ created_at: string; order_type: string; quantity: number; price: number; pnl?: number }>) {
      const date = (p.created_at || '').slice(0, 10);
      if (!date) continue;
      const row = byDate.get(date) ?? { date, buy_total: 0, sell_total: 0, pnl_total: 0 };
      const amount = (p.quantity || 0) * (p.price || 0);
      if (p.order_type === 'BUY') row.buy_total += amount;
      else { row.sell_total += amount; row.pnl_total += p.pnl ?? 0; }
      byDate.set(date, row);
    }
    paperData.value = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    data.value = [];
    paperData.value = [];
  }
  loading.value = false;
}

onMounted(load);

// 실 매매: 누적 순투자 / 수수료
// 가상 매매: 누적 P&L (별도 시리즈 — 보라색)
const chartData = computed(() => {
  // 실/가상 날짜 합집합
  const allDates = new Set<string>();
  for (const r of data.value) allDates.add(r.date);
  for (const p of paperData.value) allDates.add(p.date);
  const labels = Array.from(allDates).sort();

  // 실 매매 누적
  let cumNet = 0;
  let cumFees = 0;
  const realByDate = new Map(data.value.map(r => [r.date, r]));
  const netSeries: (number | null)[] = [];
  const feeSeries: (number | null)[] = [];
  for (const d of labels) {
    const r = realByDate.get(d);
    if (r) {
      cumNet += (r.buy_total || 0) - (r.sell_total || 0);
      cumFees += r.fees || 0;
    }
    netSeries.push(Math.round(cumNet));
    feeSeries.push(Math.round(cumFees));
  }

  // 가상 매매 누적 P&L
  let cumPaperPnL = 0;
  const paperByDate = new Map(paperData.value.map(p => [p.date, p]));
  const paperPnLSeries: (number | null)[] = [];
  for (const d of labels) {
    const p = paperByDate.get(d);
    if (p) cumPaperPnL += p.pnl_total || 0;
    paperPnLSeries.push(Math.round(cumPaperPnL));
  }

  const datasets: any[] = [
    {
      label: '실매매 누적 순투자 (원)',
      data: netSeries,
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    },
    {
      label: '실매매 누적 수수료 (원)',
      data: feeSeries,
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.05)',
      fill: false,
      tension: 0.3,
      pointRadius: 1,
      yAxisID: 'y1',
    },
  ];

  // 가상매매 데이터 있을 때만 시리즈 추가
  if (paperData.value.length > 0) {
    datasets.push({
      label: '🧪 가상매매 누적 P&L (원)',
      data: paperPnLSeries,
      borderColor: '#a855f7',
      backgroundColor: 'rgba(168, 85, 247, 0.1)',
      borderDash: [5, 5],
      fill: false,
      tension: 0.3,
      pointRadius: 2,
      yAxisID: 'y1',
    });
  }

  return { labels, datasets };
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
