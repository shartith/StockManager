<template>
  <div v-if="total > pageSize" class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-border-subtle bg-surface-2 text-sm">
    <div class="text-xs text-txt-tertiary">
      {{ startIdx + 1 }}–{{ endIdx }} / <strong class="text-txt-secondary">{{ total.toLocaleString() }}</strong>건
    </div>
    <div class="flex items-center gap-1">
      <button @click="goTo(1)" :disabled="page === 1"
        class="px-2 py-1 rounded text-xs font-medium text-txt-secondary hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="처음 페이지">« 처음</button>
      <button @click="goTo(page - 1)" :disabled="page === 1"
        class="px-2 py-1 rounded text-xs font-medium text-txt-secondary hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="이전 페이지">‹ 이전</button>

      <button v-for="p in visiblePages" :key="p" @click="goTo(p)"
        class="px-3 py-1 rounded text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :class="p === page ? 'bg-accent text-white' : 'text-txt-secondary hover:bg-surface-3'">
        {{ p }}
      </button>

      <button @click="goTo(page + 1)" :disabled="page === totalPages"
        class="px-2 py-1 rounded text-xs font-medium text-txt-secondary hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="다음 페이지">다음 ›</button>
      <button @click="goTo(totalPages)" :disabled="page === totalPages"
        class="px-2 py-1 rounded text-xs font-medium text-txt-secondary hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="마지막 페이지">끝 »</button>
    </div>
    <div class="flex items-center gap-1 text-xs text-txt-tertiary">
      <span>페이지당</span>
      <select :value="pageSize" @change="onPageSizeChange"
        class="border border-border rounded px-2 py-1 text-xs bg-surface-1">
        <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
      </select>
      <span>건</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  /** 가시 페이지 버튼 개수 (현재 페이지 주위) */
  windowSize?: number;
}>(), {
  pageSizeOptions: () => [20, 50, 100, 200],
  windowSize: 5,
});

const emit = defineEmits<{
  (e: 'update:page', value: number): void;
  (e: 'update:pageSize', value: number): void;
}>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const startIdx = computed(() => (props.page - 1) * props.pageSize);
const endIdx = computed(() => Math.min(props.page * props.pageSize, props.total));

const visiblePages = computed<number[]>(() => {
  const tp = totalPages.value;
  const w = props.windowSize;
  if (tp <= w) return Array.from({ length: tp }, (_, i) => i + 1);
  const half = Math.floor(w / 2);
  let start = Math.max(1, props.page - half);
  const end = Math.min(tp, start + w - 1);
  start = Math.max(1, end - w + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
});

function goTo(p: number) {
  const target = Math.max(1, Math.min(totalPages.value, p));
  if (target !== props.page) emit('update:page', target);
}

function onPageSizeChange(e: Event) {
  const size = Number((e.target as HTMLSelectElement).value);
  if (!Number.isFinite(size) || size <= 0) return;
  emit('update:pageSize', size);
  emit('update:page', 1); // reset to first page
}
</script>
