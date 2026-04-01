<template>
  <Doughnut :data="chartData" :options="chartOptions" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Doughnut } from 'vue-chartjs';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend);

const props = defineProps<{
  data: { label: string; value: number; percent: number }[];
}>();

const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

const chartData = computed(() => ({
  labels: props.data.map(d => `${d.label} (${d.percent}%)`),
  datasets: [{
    data: props.data.map(d => d.value),
    backgroundColor: colors.slice(0, props.data.length),
    borderWidth: 2,
    borderColor: '#fff',
  }],
}));

const chartOptions = {
  responsive: true,
  plugins: {
    legend: { position: 'bottom' as const, labels: { font: { size: 11 } } },
  },
};
</script>
