<template>
  <div class="glass-card p-5 group">
    <div class="flex items-start justify-between">
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-txt-tertiary uppercase tracking-wider">{{ label }}</p>
        <div class="mt-2">
          <AnimatedNumber
            v-if="numericValue != null"
            :value="numericValue!"
            :format="format"
            :show-sign="showSign"
            class="text-2xl font-bold"
            :class="colorClass"
          />
          <span v-else class="text-2xl font-bold" :class="colorClass">{{ value }}</span>
        </div>
        <TrendBadge v-if="change !== undefined" :value="change" class="mt-2" />
        <p v-else-if="sub" class="text-sm mt-1" :class="colorClass || 'text-txt-secondary'">{{ sub }}</p>
      </div>
      <div v-if="$slots.icon" class="ml-3 p-2.5 rounded-xl bg-surface-2 text-txt-tertiary group-hover:text-accent transition-colors">
        <slot name="icon" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AnimatedNumber from './AnimatedNumber.vue';
import TrendBadge from './TrendBadge.vue';

const props = defineProps<{
  label: string;
  value: string;
  sub?: string;
  color?: string;
  change?: number;
  numericValue?: number | null;
  format?: 'currency' | 'percent' | 'number' | 'usd';
  showSign?: boolean;
}>();

const colorClass = computed(() => {
  if (props.color) return props.color;
  return 'text-txt-primary';
});
</script>
