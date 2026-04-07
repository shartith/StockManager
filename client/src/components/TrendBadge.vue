<template>
  <span
    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors"
    :class="isPositive ? 'bg-profit text-white' : isNegative ? 'bg-loss text-white' : 'bg-surface-2 text-txt-secondary'"
  >
    <svg v-if="isPositive" class="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9V3M3 5l3-3 3 3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <svg v-else-if="isNegative" class="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 3v6M3 7l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span>{{ isPositive ? '+' : '' }}{{ value.toFixed(decimals) }}%</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  value: number;
  decimals?: number;
}>(), {
  decimals: 2,
});

const isPositive = computed(() => props.value > 0);
const isNegative = computed(() => props.value < 0);
</script>
