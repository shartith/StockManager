<template>
  <div class="bg-white rounded-xl shadow-sm p-5 border border-slate-200">
    <p class="text-xs font-medium text-slate-500 uppercase tracking-wider">{{ label }}</p>
    <p class="text-2xl font-bold mt-2" :class="color || 'text-slate-800'">{{ value }}</p>
    <p v-if="sub" class="text-sm mt-1" :class="color || 'text-slate-500'">{{ sub }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  sub?: string;
  color?: string;
}>();
</script>
