<template>
  <div>
    <!-- 헤더 — 모바일: 제목 줄 + 액션 줄, 데스크톱: 한 줄 -->
    <div class="mb-6">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-xl md:text-2xl font-bold text-txt-primary">감시대상</h2>
          <p class="text-xs md:text-sm text-txt-tertiary mt-0.5">자동(섹터 로테이션) + 수동(직접 등록) 통합</p>
        </div>
        <button @click="refresh" class="p-2 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-surface-2 shrink-0"
          aria-label="새로고침">
          <svg class="w-5 h-5" :class="{ 'animate-spin': loading }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <button @click="rebuildAuto" :disabled="rebuilding"
        class="mt-3 w-full md:hidden px-4 py-2.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50">
        {{ rebuilding ? '빌드 중…' : '🤖 자동목록 재빌드' }}
      </button>
      <button @click="rebuildAuto" :disabled="rebuilding"
        class="hidden md:inline-flex mt-2 float-right px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50">
        {{ rebuilding ? '빌드 중…' : '🤖 자동목록 재빌드' }}
      </button>
    </div>

    <!-- Tab: 자동 / 수동 / 전체 -->
    <div class="flex gap-1 p-1 glass-card mb-6 w-fit">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
        :class="activeTab === tab.key ? 'bg-accent text-white shadow-sm' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-2'">
        {{ tab.label }}
        <span class="ml-1 text-xs opacity-70">({{ countBy(tab.key) }})</span>
      </button>
    </div>

    <!-- 수동 추가 폼 -->
    <div v-if="activeTab === 'manual' || activeTab === 'all'" class="glass-card p-4 mb-6">
      <h3 class="text-sm font-semibold text-txt-primary mb-3">👤 수동 추가</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input v-model="manualForm.ticker" type="text" placeholder="종목코드 (예: 005930)"
          class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        <input v-model="manualForm.name" type="text" placeholder="종목명"
          class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        <button @click="addManual" :disabled="!manualForm.ticker || !manualForm.name"
          class="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
          + 추가
        </button>
      </div>
      <input v-model="manualForm.reason" type="text" placeholder="메모 (선택)"
        class="w-full mt-3 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
    </div>

    <!-- 목록 — md+ 테이블 / 모바일 카드 -->
    <div class="glass-card overflow-hidden">
      <div v-if="filtered.length === 0" class="p-10 md:p-12 text-center text-txt-tertiary text-sm">
        {{ activeTab === 'auto' ? '자동목록이 비어 있습니다. 08:50에 자동 빌드되거나 위 버튼으로 즉시 빌드하세요.' :
           activeTab === 'manual' ? '수동 등록된 감시대상이 없습니다.' : '감시대상이 비어 있습니다.' }}
      </div>

      <!-- 데스크톱 테이블 -->
      <table v-if="filtered.length > 0" class="table-modern w-full hidden md:table">
        <thead>
          <tr>
            <th class="text-left">종목</th>
            <th class="text-center">출처</th>
            <th class="text-left">카테고리</th>
            <th class="text-left">사유</th>
            <th class="text-right">만료</th>
            <th class="text-right">액션</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in filtered" :key="t.id">
            <td>
              <p class="font-medium text-txt-primary">{{ t.name }}</p>
              <p class="text-xs text-txt-tertiary">{{ t.ticker }}</p>
            </td>
            <td class="text-center">
              <span class="px-2 py-0.5 rounded-md text-[10px] font-medium"
                :class="t.source === 'auto' ? 'bg-accent-dim text-accent' : 'bg-profit/10 text-profit'">
                {{ t.source === 'auto' ? '🤖 자동' : '👤 수동' }}
              </span>
            </td>
            <td class="text-xs text-txt-secondary">{{ t.category || '-' }}</td>
            <td class="text-xs text-txt-secondary truncate max-w-[300px]" :title="t.reason">{{ t.reason || '-' }}</td>
            <td class="text-right text-xs text-txt-tertiary">
              {{ t.expiresAt ? formatDate(t.expiresAt) : '무기한' }}
            </td>
            <td class="text-right">
              <button @click="remove(t.id)" class="text-xs text-loss hover:underline">삭제</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 모바일 카드 -->
      <div v-if="filtered.length > 0" class="md:hidden divide-y divide-border-subtle">
        <div v-for="t in filtered" :key="t.id" class="mobile-card">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-semibold text-sm">{{ t.name }}</span>
                <span class="text-xs text-txt-tertiary">{{ t.ticker }}</span>
              </div>
              <div class="flex items-center gap-1.5 flex-wrap mt-1">
                <span class="px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                  :class="t.source === 'auto' ? 'bg-accent-dim text-accent' : 'bg-profit/10 text-profit'">
                  {{ t.source === 'auto' ? '🤖 자동' : '👤 수동' }}
                </span>
                <span v-if="t.category" class="px-1.5 py-0.5 rounded-md text-[10px] bg-surface-2 text-txt-secondary">
                  {{ t.category }}
                </span>
                <span class="text-[10px] text-txt-tertiary">
                  {{ t.expiresAt ? formatDate(t.expiresAt) : '무기한' }}
                </span>
              </div>
            </div>
            <button @click="remove(t.id)"
              class="text-xs text-loss px-3 py-1.5 -mr-2 active:bg-red-50 rounded shrink-0">삭제</button>
          </div>
          <p v-if="t.reason" class="text-[11px] text-txt-secondary line-clamp-2 leading-snug">{{ t.reason }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { watchTargetsApi } from '@/api';

interface WatchTarget {
  id: number;
  stockId: number;
  ticker: string;
  name: string;
  sector: string;
  source: 'auto' | 'manual';
  category: string;
  reason: string;
  addedAt: string;
  expiresAt: string | null;
}

const tabs = [
  { key: 'all', label: '전체' },
  { key: 'auto', label: '🤖 자동' },
  { key: 'manual', label: '👤 수동' },
] as const;

type TabKey = typeof tabs[number]['key'];

const activeTab = ref<TabKey>('all');
const items = ref<WatchTarget[]>([]);
const loading = ref(false);
const rebuilding = ref(false);

const manualForm = ref({ ticker: '', name: '', reason: '' });

const filtered = computed(() => {
  if (activeTab.value === 'all') return items.value;
  return items.value.filter(t => t.source === activeTab.value);
});

function countBy(tab: TabKey): number {
  if (tab === 'all') return items.value.length;
  return items.value.filter(t => t.source === tab).length;
}

async function refresh() {
  loading.value = true;
  try {
    const { data } = await watchTargetsApi.getAll();
    items.value = data.items;
  } finally {
    loading.value = false;
  }
}

async function addManual() {
  if (!manualForm.value.ticker || !manualForm.value.name) return;
  await watchTargetsApi.addManual({
    ticker: manualForm.value.ticker.trim(),
    name: manualForm.value.name.trim(),
    reason: manualForm.value.reason.trim() || '수동 등록',
  });
  manualForm.value = { ticker: '', name: '', reason: '' };
  await refresh();
}

async function remove(id: number) {
  if (!confirm('정말 삭제하시겠습니까?')) return;
  await watchTargetsApi.remove(id);
  await refresh();
}

async function rebuildAuto() {
  rebuilding.value = true;
  try {
    await watchTargetsApi.rebuildAuto();
    await refresh();
  } finally {
    rebuilding.value = false;
  }
}

function formatDate(s: string): string {
  return new Date(s).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

onMounted(refresh);
</script>
