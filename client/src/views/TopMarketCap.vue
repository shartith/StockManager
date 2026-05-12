<template>
  <div>
    <!-- 헤더 -->
    <div class="mb-6">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-xl md:text-2xl font-bold text-txt-primary">시총 Top 10</h2>
          <p class="text-xs md:text-sm text-txt-tertiary mt-0.5">
            KOSPI + KOSDAQ 통합 시가총액 상위 10개 종목 (우선주 포함)
          </p>
          <p v-if="fetchedAt" class="text-[11px] text-txt-tertiary mt-1">
            갱신: {{ formatTime(fetchedAt) }}
            <span v-if="source === 'naver-mobile-stale'" class="ml-2 text-amber-600">⚠ stale cache</span>
          </p>
        </div>
        <button
          @click="refresh"
          class="p-2 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-surface-2 shrink-0"
          aria-label="시총 새로고침"
        >
          <svg class="w-5 h-5" :class="{ 'animate-spin': loading }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <button
        @click="manualRebalance"
        :disabled="rebalancing"
        class="mt-3 w-full md:w-auto md:float-right md:mt-0 px-4 py-2.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50"
      >
        {{ rebalancing ? '실행 중…' : '🔄 수동 rebalance' }}
      </button>
    </div>

    <!-- Top 10 카드 -->
    <div class="glass-card overflow-hidden mb-6">
      <div v-if="loading && top10.length === 0" class="p-10 text-center text-txt-tertiary text-sm">
        시총 데이터 로딩 중…
      </div>
      <div v-else-if="top10.length === 0" class="p-10 text-center text-txt-tertiary text-sm">
        데이터 없음 — 새로고침을 눌러주세요.
      </div>

      <!-- 데스크톱 테이블 -->
      <table v-if="top10.length > 0" class="table-modern w-full hidden md:table">
        <thead>
          <tr>
            <th class="text-left w-12">#</th>
            <th class="text-left">종목</th>
            <th class="text-center">시장</th>
            <th class="text-right">시가총액</th>
            <th class="text-right">현재가</th>
            <th class="text-right">등락률</th>
            <th class="text-center">보유</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in top10" :key="s.ticker" :class="{ 'bg-accent/5': s.held }">
            <td class="font-bold text-txt-primary">{{ s.rank }}</td>
            <td>
              <p class="font-medium text-txt-primary">{{ s.name }}</p>
              <p class="text-xs text-txt-tertiary">{{ s.ticker }}</p>
            </td>
            <td class="text-center">
              <span class="px-2 py-0.5 rounded-full text-xs font-medium"
                :class="s.market === 'KOSPI' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'">
                {{ s.market }}
              </span>
            </td>
            <td class="text-right text-sm">
              <span class="text-txt-primary">{{ s.marketCapHangeul || formatEok(s.marketCapEok) }}</span>
            </td>
            <td class="text-right text-sm tabular-nums text-txt-primary">
              {{ formatPrice(s.closePrice) }}원
            </td>
            <td class="text-right text-sm tabular-nums"
              :class="changeColor(s.fluctuationsRatio)">
              {{ formatRatio(s.fluctuationsRatio) }}
            </td>
            <td class="text-center">
              <span v-if="s.held" class="text-xs font-semibold text-accent">
                ✓ {{ s.heldQuantity }}주
              </span>
              <span v-else class="text-xs text-txt-tertiary">—</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 모바일 카드 -->
      <div v-if="top10.length > 0" class="md:hidden divide-y divide-border">
        <div v-for="s in top10" :key="s.ticker" class="p-4" :class="{ 'bg-accent/5': s.held }">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-bold text-lg text-txt-primary w-7 shrink-0">{{ s.rank }}</span>
              <div class="min-w-0">
                <p class="font-medium text-txt-primary truncate">{{ s.name }}</p>
                <p class="text-[11px] text-txt-tertiary">{{ s.ticker }} · {{ s.market }}</p>
              </div>
            </div>
            <span v-if="s.held" class="text-xs font-semibold text-accent shrink-0">
              ✓ {{ s.heldQuantity }}주
            </span>
          </div>
          <div class="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div class="text-txt-tertiary">시총</div>
              <div class="font-medium text-txt-primary truncate">{{ s.marketCapHangeul || formatEok(s.marketCapEok) }}</div>
            </div>
            <div class="text-right">
              <div class="text-txt-tertiary">현재가</div>
              <div class="font-medium text-txt-primary tabular-nums">{{ formatPrice(s.closePrice) }}</div>
            </div>
            <div class="text-right">
              <div class="text-txt-tertiary">등락</div>
              <div class="font-medium tabular-nums" :class="changeColor(s.fluctuationsRatio)">
                {{ formatRatio(s.fluctuationsRatio) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 보유 중인데 Top 10 밖 (다음 rebalance에서 매도 대상) -->
    <div v-if="heldNotInTop10.length > 0" class="glass-card p-4 mb-6 border-l-4 border-amber-500">
      <h3 class="text-sm font-semibold text-txt-primary mb-2">
        ⚠ 보유 중 Top 10 이탈 — {{ heldNotInTop10.length }}건
      </h3>
      <p class="text-xs text-txt-tertiary mb-3">
        다음 rebalance 사이클(매시 정각)에 시장가 매도 예정
      </p>
      <ul class="space-y-1">
        <li v-for="h in heldNotInTop10" :key="h.ticker"
          class="flex justify-between text-sm">
          <span class="text-txt-primary font-medium">{{ h.ticker }}</span>
          <span class="text-txt-tertiary tabular-nums">{{ h.quantity }}주</span>
        </li>
      </ul>
    </div>

    <!-- 전략 안내 -->
    <details class="glass-card p-4 text-sm text-txt-secondary">
      <summary class="font-semibold text-txt-primary cursor-pointer">전략 동작 방식</summary>
      <ul class="mt-3 space-y-1 list-disc list-inside">
        <li>매일 <strong>09:00</strong> 시총 Top 10 산정 → rebalance</li>
        <li>매시 <strong>10:00~14:00</strong> 시총 재산정 → 변경 시 즉시 rebalance</li>
        <li>보유 중 Top 10 이탈 → 시장가 매도 (시장 브레이크 무시, 항상 진행)</li>
        <li>Top 10 신규 진입 → 가용현금 균등 분배 매수 (시장 브레이크 시 차단)</li>
        <li>매수 단위: floor(가용현금 / 신규 종목 수). 1주 가격이 한도 초과면 1주 시도, 그래도 불가능하면 skip</li>
      </ul>
    </details>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { topMarketCapApi } from '@/api';

interface TopStock {
  rank: number;
  ticker: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  marketCapKrw: number;
  marketCapEok: number;
  marketCapHangeul: string;
  closePrice: number;
  fluctuationsRatio: number;
  held: boolean;
  heldQuantity: number;
}

interface ApiResponse {
  top10: TopStock[];
  fetchedAt: string;
  source: string;
  heldNotInTop10: Array<{ ticker: string; quantity: number }>;
}

const top10 = ref<TopStock[]>([]);
const heldNotInTop10 = ref<Array<{ ticker: string; quantity: number }>>([]);
const fetchedAt = ref<string>('');
const source = ref<string>('');
const loading = ref(false);
const rebalancing = ref(false);

async function load(force = false): Promise<void> {
  loading.value = true;
  try {
    const { data } = await topMarketCapApi.get(force);
    const res = data as ApiResponse;
    top10.value = res.top10 ?? [];
    heldNotInTop10.value = res.heldNotInTop10 ?? [];
    fetchedAt.value = res.fetchedAt ?? '';
    source.value = res.source ?? '';
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  await load(true);
}

async function manualRebalance(): Promise<void> {
  if (rebalancing.value) return;
  if (!confirm('수동 rebalance를 실행합니다. 시총 Top 10 이탈 매도 + 신규 진입 매수가 즉시 진행됩니다.')) return;
  rebalancing.value = true;
  try {
    await topMarketCapApi.rebalance('manual UI trigger');
    await load(true);
  } finally {
    rebalancing.value = false;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

function formatPrice(price: number): string {
  return price.toLocaleString('ko-KR');
}

function formatRatio(r: number): string {
  if (r > 0) return `+${r.toFixed(2)}%`;
  return `${r.toFixed(2)}%`;
}

function changeColor(r: number): string {
  if (r > 0) return 'text-profit';
  if (r < 0) return 'text-loss';
  return 'text-txt-tertiary';
}

function formatEok(eok: number): string {
  if (eok >= 1_000_000) return `${(eok / 10_000).toFixed(1)}조`;
  if (eok >= 10_000) return `${(eok / 10_000).toFixed(2)}조`;
  return `${eok.toLocaleString()}억`;
}

onMounted(() => {
  void load(false);
});
</script>
