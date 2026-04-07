<template>
  <div class="flex items-center gap-2 px-3 py-2 text-xs">
    <span class="status-dot" :class="status" />
    <span class="text-txt-tertiary">
      <template v-if="status === 'connected'">
        실시간
        <span v-if="lastUpdate" class="ml-1 opacity-60">{{ timeAgo }}</span>
      </template>
      <template v-else-if="status === 'polling'">
        폴링 ({{ intervalLabel }})
      </template>
      <template v-else>
        연결 끊김
      </template>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  status: 'connected' | 'polling' | 'disconnected';
  lastUpdate: Date | null;
  intervalMs?: number;
}>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

const intervalLabel = computed(() => {
  if (!props.intervalMs) return '';
  const sec = Math.round(props.intervalMs / 1000);
  return sec >= 60 ? `${Math.round(sec / 60)}분` : `${sec}초`;
});

const timeAgo = computed(() => {
  if (!props.lastUpdate) return '';
  const diff = Math.floor((now.value - props.lastUpdate.getTime()) / 1000);
  if (diff < 5) return '방금';
  if (diff < 60) return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  return `${Math.floor(diff / 3600)}시간 전`;
});

onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 5000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>
