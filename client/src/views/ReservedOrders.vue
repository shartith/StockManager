<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-txt-primary">예약 주문</h2>
        <p class="text-sm text-txt-tertiary mt-0.5">지정가 도달 시 자동 매수/매도</p>
      </div>
      <button @click="refresh" class="p-2 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-surface-2"
        aria-label="새로고침">
        <svg class="w-5 h-5" :class="{ 'animate-spin': loading }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- 신규 등록 폼 -->
    <div class="glass-card p-4 mb-6">
      <h3 class="text-sm font-semibold text-txt-primary mb-3">+ 신규 예약 주문</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">종목코드</label>
          <input v-model="form.ticker" type="text" placeholder="005930"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">종목명 (신규 시)</label>
          <input v-model="form.name" type="text" placeholder="삼성전자"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">매수/매도</label>
          <select v-model="form.orderType"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="BUY">매수</option>
            <option value="SELL">매도</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">조건</label>
          <select v-model="form.condition"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="BELOW">목표가 이하 도달</option>
            <option value="ABOVE">목표가 이상 도달</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">목표가 (KRW)</label>
          <input v-model.number="form.targetPrice" type="number" min="0" step="100"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">수량 (0=자동산정 매수)</label>
          <input v-model.number="form.quantity" type="number" min="0"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div class="md:col-span-2">
          <label class="block text-xs font-medium text-txt-secondary mb-1">메모 (선택)</label>
          <input v-model="form.reason" type="text" placeholder="예: 지지선 매수"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
      </div>
      <div class="mt-3 text-right">
        <button @click="create" :disabled="!canSubmit"
          class="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
          예약 등록
        </button>
      </div>
      <p class="text-xs text-txt-tertiary mt-2">
        💡 매수: 보통 BELOW (싸지면 매수). 매도: 보통 ABOVE (오르면 매도).
        브레이크아웃 매수는 BUY+ABOVE로도 가능.
      </p>
    </div>

    <!-- 활성 예약 — md+ 테이블 / 모바일 카드 -->
    <div class="glass-card overflow-hidden">
      <div v-if="orders.length === 0" class="p-10 md:p-12 text-center text-txt-tertiary text-sm">
        활성 예약 주문이 없습니다.
      </div>

      <!-- 데스크톱 테이블 -->
      <table v-if="orders.length > 0" class="table-modern w-full hidden md:table">
        <thead>
          <tr>
            <th class="text-left">종목</th>
            <th class="text-center">유형</th>
            <th class="text-right">목표가</th>
            <th class="text-center">조건</th>
            <th class="text-right">수량</th>
            <th class="text-left">메모</th>
            <th class="text-right">등록일</th>
            <th class="text-right">액션</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.id">
            <td class="font-medium text-txt-primary">{{ o.ticker }}</td>
            <td class="text-center">
              <span class="px-2 py-0.5 rounded-md text-[10px] font-medium"
                :class="o.orderType === 'BUY' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'">
                {{ o.orderType === 'BUY' ? '매수' : '매도' }}
              </span>
            </td>
            <td class="text-right tabular-nums">{{ o.targetPrice.toLocaleString() }}</td>
            <td class="text-center text-xs text-txt-secondary">
              {{ o.condition === 'BELOW' ? '이하' : '이상' }}
            </td>
            <td class="text-right tabular-nums">{{ o.quantity || '자동' }}</td>
            <td class="text-xs text-txt-secondary truncate max-w-[200px]" :title="o.reason">{{ o.reason || '-' }}</td>
            <td class="text-right text-xs text-txt-tertiary">{{ formatDate(o.createdAt) }}</td>
            <td class="text-right">
              <button @click="cancel(o.id)" class="text-xs text-loss hover:underline">취소</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 모바일 카드 -->
      <div v-if="orders.length > 0" class="md:hidden divide-y divide-border-subtle">
        <div v-for="o in orders" :key="o.id" class="mobile-card">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-semibold text-sm">{{ o.ticker }}</span>
                <span class="px-2 py-0.5 rounded-md text-[10px] font-medium"
                  :class="o.orderType === 'BUY' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'">
                  {{ o.orderType === 'BUY' ? '매수' : '매도' }}
                </span>
              </div>
              <div class="text-[11px] text-txt-tertiary mt-0.5">{{ formatDate(o.createdAt) }}</div>
            </div>
            <button @click="cancel(o.id)"
              class="text-xs text-loss px-3 py-1.5 -mr-2 active:bg-red-50 rounded shrink-0">취소</button>
          </div>
          <div class="grid grid-cols-3 gap-2 text-xs pt-1">
            <div class="flex flex-col">
              <span class="text-txt-tertiary text-[10px]">목표가</span>
              <span class="font-medium tabular-nums">{{ o.targetPrice.toLocaleString() }}</span>
            </div>
            <div class="flex flex-col">
              <span class="text-txt-tertiary text-[10px]">조건</span>
              <span class="font-medium">{{ o.condition === 'BELOW' ? '이하' : '이상' }}</span>
            </div>
            <div class="flex flex-col">
              <span class="text-txt-tertiary text-[10px]">수량</span>
              <span class="font-medium tabular-nums">{{ o.quantity || '자동' }}</span>
            </div>
          </div>
          <p v-if="o.reason" class="text-[11px] text-txt-secondary line-clamp-2 leading-snug">{{ o.reason }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { reservedOrdersApi } from '@/api';

interface ReservedOrder {
  id: number;
  stockId: number;
  ticker: string;
  market: string;
  orderType: 'BUY' | 'SELL';
  targetPrice: number;
  condition: 'BELOW' | 'ABOVE';
  quantity: number;
  reason: string;
  createdAt: string;
}

const orders = ref<ReservedOrder[]>([]);
const loading = ref(false);

const form = ref({
  ticker: '',
  name: '',
  orderType: 'BUY' as 'BUY' | 'SELL',
  condition: 'BELOW' as 'BELOW' | 'ABOVE',
  targetPrice: 0,
  quantity: 0,
  reason: '',
});

const canSubmit = computed(() =>
  form.value.ticker.trim().length > 0 && form.value.targetPrice > 0
);

async function refresh() {
  loading.value = true;
  try {
    const { data } = await reservedOrdersApi.getAll();
    orders.value = data.items;
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (!canSubmit.value) return;
  await reservedOrdersApi.create({
    ticker: form.value.ticker.trim(),
    name: form.value.name.trim() || undefined,
    orderType: form.value.orderType,
    targetPrice: form.value.targetPrice,
    condition: form.value.condition,
    quantity: form.value.quantity || 0,
    reason: form.value.reason.trim() || undefined,
  });
  form.value = {
    ticker: '', name: '',
    orderType: 'BUY', condition: 'BELOW',
    targetPrice: 0, quantity: 0, reason: '',
  };
  await refresh();
}

async function cancel(id: number) {
  if (!confirm('예약 주문을 취소하시겠습니까?')) return;
  await reservedOrdersApi.cancel(id);
  await refresh();
}

function formatDate(s: string): string {
  return new Date(s).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

onMounted(refresh);
</script>
