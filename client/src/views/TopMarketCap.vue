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

    <!-- 보유 중인데 Top 10 밖 (순위 이탈 매도 감시 대상) -->
    <div v-if="heldNotInTop10.length > 0" class="glass-card p-4 mb-6 border-l-4 border-amber-500">
      <h3 class="text-sm font-semibold text-txt-primary mb-2">
        ⚠ 보유 중 Top 10 이탈 — {{ heldNotInTop10.length }}건
      </h3>
      <p class="text-xs text-txt-tertiary mb-3">
        Top 10 이탈만으로는 매도하지 않습니다. Top 20 밖으로 2거래일 연속 이탈해야 순위 매도 후보 (트레일링 활성 종목·급락장은 제외).
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
      <ul class="mt-3 space-y-1.5 list-disc list-inside">
        <li>스케줄: <strong>09:05</strong> 1차 → 매시 <strong>10~14시</strong> 재평가 → <strong>14:30</strong> KOSPI 급등 시 이익실현 (NXT 켜면 08:40·16:00·18:00 추가)</li>
        <li>종목 선택: 설정에 따라 <strong>시총 Top 10</strong> 또는 <strong>가격 모멘텀 Top 10</strong> (시총 Top 30 중 120일 상위)</li>
        <li>매도 ① 트레일링: 수익이 설정 활성률(기본 +10%) 도달 후 고점 대비 하락폭(기본 −2%) 이탈 시</li>
        <li>매도 ② 순위 이탈: Top 20 밖 2거래일 연속 (큰 손실·급락장은 보류) — Top 10 이탈만으론 안 팖</li>
        <li>매도 ③ KOSPI +4% 급등 + 보유 수익 +5% 이상 → 이익실현</li>
        <li>매수: 미보유 Top 10 + 11~20위 상승추세를 1주씩, 잔여 현금은 보유 Top 10 재분배 (시장 브레이크·죽는장·200일선 약세 시 신규 매수 차단)</li>
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
  if (!confirm('수동 rebalance를 실행합니다. 트레일링·순위이탈 매도 + 신규 진입 매수가 즉시 평가/실행됩니다.')) return;
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
