<template>
  <div v-if="type === 'card'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
    <div v-for="i in 4" :key="i" class="glass-card p-5">
      <div class="h-3 w-20 rounded bg-surface-3 animate-pulse mb-3" />
      <div class="h-7 w-32 rounded bg-surface-3 animate-pulse" />
    </div>
  </div>

  <div v-else-if="type === 'table'" class="solid-card overflow-hidden">
    <div class="px-5 py-4 border-b border-border">
      <div class="h-4 w-28 rounded bg-surface-3 animate-pulse" />
    </div>
    <div class="divide-y divide-border-subtle">
      <div v-for="i in rows" :key="i" class="flex items-center gap-4 px-5 py-3">
        <div class="h-4 w-24 rounded bg-surface-3 animate-pulse" />
        <div class="h-4 w-16 rounded bg-surface-3 animate-pulse" />
        <div class="h-4 w-20 rounded bg-surface-3 animate-pulse ml-auto" />
        <div class="h-4 w-14 rounded bg-surface-3 animate-pulse" />
      </div>
    </div>
  </div>

  <div v-else-if="type === 'chart'" class="glass-card p-5">
    <div class="h-4 w-24 rounded bg-surface-3 animate-pulse mb-4" />
    <div class="flex items-end gap-2 h-40">
      <div
        v-for="i in 8"
        :key="i"
        class="flex-1 rounded-t bg-surface-3 animate-pulse"
        :style="{ height: `${20 + Math.random() * 80}%` }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    type: 'card' | 'table' | 'chart';
    rows?: number;
  }>(),
  { rows: 5 },
);
</script>
