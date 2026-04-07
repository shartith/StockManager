<template>
  <span class="tabular-nums" :class="flashClass">{{ formatted }}</span>
</template>

<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue';

const props = withDefaults(defineProps<{
  value: number;
  duration?: number;
  format?: 'currency' | 'percent' | 'number' | 'usd';
  decimals?: number;
  showSign?: boolean;
}>(), {
  duration: 600,
  format: 'number',
  decimals: 0,
  showSign: false,
});

const displayValue = ref(props.value);
const flashClass = ref('');
let rafId: number | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const formatted = computed(() => {
  const v = displayValue.value;
  const sign = props.showSign && v > 0 ? '+' : '';

  switch (props.format) {
    case 'currency':
      return sign + new Intl.NumberFormat('ko-KR', {
        style: 'currency',
        currency: 'KRW',
        maximumFractionDigits: 0,
      }).format(v);
    case 'usd':
      return sign + new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(v);
    case 'percent':
      return sign + v.toFixed(props.decimals) + '%';
    default:
      return sign + v.toLocaleString(undefined, {
        maximumFractionDigits: props.decimals,
      });
  }
});

function animate(from: number, to: number) {
  if (rafId !== null) cancelAnimationFrame(rafId);

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || props.duration <= 0) {
    displayValue.value = to;
    return;
  }

  const startTime = performance.now();
  const diff = to - from;

  function tick(now: number) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / props.duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    displayValue.value = from + diff * eased;

    if (progress < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      displayValue.value = to;
      rafId = null;
    }
  }

  rafId = requestAnimationFrame(tick);
}

watch(() => props.value, (newVal, oldVal) => {
  if (newVal === oldVal) return;

  flashClass.value = newVal > oldVal ? 'flash-profit' : 'flash-loss';
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashClass.value = ''; flashTimer = null; }, 600);

  animate(oldVal, newVal);
}, { immediate: false });

// Initialize without animation
displayValue.value = props.value;

onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (flashTimer !== null) clearTimeout(flashTimer);
});
</script>
