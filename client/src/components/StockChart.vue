<template>
  <Bar :data="chartData" :options="chartOptions" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Bar } from 'vue-chartjs';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const props = defineProps<{
  holdings: any[];
}>();

const chartData = computed(() => ({
  labels: props.holdings.map(h => h.ticker),
  datasets: [{
    label: '수익률 (%)',
    data: props.holdings.map(h => h.profitLossPercent ?? 0),
    backgroundColor: props.holdings.map(h =>
      (h.profitLossPercent ?? 0) >= 0 ? 'rgba(220, 38, 38, 0.7)' : 'rgba(59, 130, 246, 0.7)'
    ),
    borderRadius: 4,
  }],
}));

const chartOptions = {
  responsive: true,
  plugins: {
    legend: { display: false },
  },
  scales: {
    y: {
      ticks: { callback: (v: any) => `${v}%` },
      grid: { color: '#f1f5f9' },
    },
    x: { grid: { display: false } },
  },
};
</script>
