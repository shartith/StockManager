<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-txt-primary">거래 내역</h2>
      <button @click="showForm = true" class="bg-primary text-white px-4 py-2 rounded-lg text-sm hover:bg-primary-hover transition">
        + 거래 추가
      </button>
    </div>

    <!-- 통계 카드 -->
    <div v-if="transactions.length > 0" class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      <div class="bg-surface-1 rounded-lg border border-border p-3">
        <p class="text-xs text-txt-secondary">총 거래</p>
        <p class="text-lg font-bold text-txt-primary">{{ transactions.length }}건</p>
      </div>
      <div class="bg-surface-1 rounded-lg border border-border p-3">
        <p class="text-xs text-txt-secondary">매수</p>
        <p class="text-lg font-bold text-profit">{{ stats.buyCount }}건</p>
      </div>
      <div class="bg-surface-1 rounded-lg border border-border p-3">
        <p class="text-xs text-txt-secondary">매도</p>
        <p class="text-lg font-bold text-loss">{{ stats.sellCount }}건</p>
      </div>
      <div class="bg-surface-1 rounded-lg border border-border p-3">
        <p class="text-xs text-txt-secondary">총 수수료</p>
        <p class="text-lg font-bold text-txt-primary">{{ formatNumber(stats.totalFees) }}</p>
      </div>
      <div class="bg-surface-1 rounded-lg border border-border p-3">
        <p class="text-xs text-txt-secondary">자동매매</p>
        <p class="text-lg font-bold text-txt-primary">{{ stats.autoCount }}건</p>
      </div>
    </div>

    <!-- 필터 -->
    <div class="flex gap-2 mb-4 flex-wrap">
      <select v-model="filter.type" class="border border-border rounded-lg px-3 py-1.5 text-sm">
        <option value="">전체 유형</option>
        <option value="BUY">매수</option>
        <option value="SELL">매도</option>
      </select>
      <select v-model="filter.stockId" class="border border-border rounded-lg px-3 py-1.5 text-sm">
        <option value="">전체 종목</option>
        <option v-for="s in stocks" :key="s.id" :value="s.id">{{ s.ticker }} {{ s.name }}</option>
      </select>
      <select v-model="filter.source" class="border border-border rounded-lg px-3 py-1.5 text-sm">
        <option value="">전체 (실/가상)</option>
        <option value="manual">수동 (실)</option>
        <option value="auto">자동매매 (실)</option>
        <option value="paper">🧪 가상매매</option>
        <option value="real">실매매만 (수동+자동)</option>
      </select>
    </div>

    <!-- 거래 추가 모달 -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-surface-1 rounded-xl p-6 w-full max-w-md shadow-lg">
        <h3 class="text-lg font-bold mb-4">거래 추가</h3>
        <form @submit.prevent="addTransaction" class="space-y-3">
          <div>
            <label class="block text-sm text-txt-secondary mb-1">종목 *</label>
            <select v-model="form.stock_id" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required>
              <option value="">선택하세요</option>
              <option v-for="s in stocks" :key="s.id" :value="s.id">{{ s.ticker }} - {{ s.name }}</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-txt-secondary mb-1">거래 유형 *</label>
            <div class="flex gap-2">
              <button type="button" @click="form.type = 'BUY'"
                class="flex-1 py-2 rounded-lg text-sm font-medium transition"
                :class="form.type === 'BUY' ? 'bg-red-500 text-white' : 'bg-surface-3 text-txt-secondary'">매수</button>
              <button type="button" @click="form.type = 'SELL'"
                class="flex-1 py-2 rounded-lg text-sm font-medium transition"
                :class="form.type === 'SELL' ? 'bg-blue-500 text-white' : 'bg-surface-3 text-txt-secondary'">매도</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm text-txt-secondary mb-1">수량 *</label>
              <input v-model.number="form.quantity" type="number" min="0" step="any" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required />
            </div>
            <div>
              <label class="block text-sm text-txt-secondary mb-1">가격 *</label>
              <input v-model.number="form.price" type="number" min="0" step="any" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm text-txt-secondary mb-1">수수료</label>
              <input v-model.number="form.fee" type="number" min="0" step="any" class="w-full border border-border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm text-txt-secondary mb-1">날짜 *</label>
              <input v-model="form.date" type="date" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required />
            </div>
          </div>
          <div>
            <label class="block text-sm text-txt-secondary mb-1">메모</label>
            <input v-model="form.memo" class="w-full border border-border rounded-lg px-3 py-2 text-sm" placeholder="선택 사항" />
          </div>
          <div class="flex gap-2 pt-2">
            <button type="submit" class="flex-1 bg-primary text-white py-2 rounded-lg text-sm hover:bg-primary-hover">추가</button>
            <button type="button" @click="showForm = false" class="flex-1 bg-surface-3 text-txt-secondary py-2 rounded-lg text-sm hover:bg-surface-3">취소</button>
          </div>
        </form>
        <p v-if="formError" class="text-red-500 text-sm mt-2">{{ formError }}</p>
      </div>
    </div>

    <!-- 거래 내역 테이블 -->
    <div class="bg-surface-1 rounded-xl shadow-sm border border-border">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface-2 text-txt-secondary">
            <tr>
              <th class="text-left px-4 py-3">날짜</th>
              <th class="text-left px-4 py-3">종목</th>
              <th class="text-center px-4 py-3">유형</th>
              <th class="text-right px-4 py-3">수량</th>
              <th class="text-right px-4 py-3">가격</th>
              <th class="text-right px-4 py-3">금액</th>
              <th class="text-right px-4 py-3">수수료</th>
              <th class="text-right px-4 py-3">실질금액</th>
              <th class="text-left px-4 py-3">메모</th>
              <th class="text-center px-4 py-3">관리</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in pagedTransactions" :key="t.id" class="border-t border-border-subtle hover:bg-surface-2">
              <td class="px-4 py-3 text-txt-secondary">{{ t.date }}</td>
              <td class="px-4 py-3">
                <span class="font-medium">{{ t.ticker }}</span>
                <span class="text-txt-tertiary text-xs ml-1">{{ t.stock_name }}</span>
              </td>
              <td class="px-4 py-3 text-center">
                <span class="px-2 py-0.5 rounded text-xs font-medium"
                  :class="t.type === 'BUY' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'">
                  {{ t.type === 'BUY' ? '매수' : '매도' }}
                </span>
                <span v-if="t.is_paper" class="ml-1 px-1.5 py-0.5 rounded text-xs bg-purple-200 text-purple-800 font-bold">🧪 가상</span>
                <span v-else-if="isAutoTrade(t)" class="ml-1 px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-700">자동</span>
              </td>
              <td class="text-right px-4 py-3">{{ t.quantity }}</td>
              <td class="text-right px-4 py-3">{{ formatNumber(t.price) }}</td>
              <td class="text-right px-4 py-3 font-medium">{{ formatNumber(t.quantity * t.price) }}</td>
              <td class="text-right px-4 py-3 text-txt-secondary">{{ formatNumber(t.fee) }}</td>
              <td class="text-right px-4 py-3 font-medium"
                :class="t.type === 'BUY' ? 'text-profit' : 'text-loss'">
                {{ t.type === 'BUY' ? '-' : '+' }}{{ formatNumber(getNetAmount(t)) }}
              </td>
              <td class="px-4 py-3 text-txt-tertiary text-xs max-w-[150px] truncate">{{ t.memo || '-' }}</td>
              <td class="px-4 py-3 text-center">
                <button v-if="!t.is_paper" @click="deleteTransaction(t.id)" class="text-red-500 hover:text-red-700 text-xs">삭제</button>
                <span v-else class="text-xs text-txt-tertiary">-</span>
              </td>
            </tr>
            <tr v-if="filteredTransactions.length === 0">
              <td colspan="10" class="text-center py-8 text-txt-tertiary">거래 내역이 없습니다</td>
            </tr>
          </tbody>
        </table>
        <PaginationBar
          v-model:page="txPage"
          v-model:pageSize="txPageSize"
          :total="filteredTransactions.length"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { stocksApi, transactionsApi, paperTradingApi } from '@/api';
import { usePagination } from '@/composables/usePagination';
import PaginationBar from '@/components/PaginationBar.vue';

const stocks = ref<any[]>([]);
const transactions = ref<any[]>([]);
const showForm = ref(false);
const formError = ref('');

const filter = ref({ type: '', stockId: '', source: '' });

const today = new Date().toISOString().split('T')[0];
const form = ref({ stock_id: '', type: 'BUY' as 'BUY' | 'SELL', quantity: 0, price: 0, fee: 0, date: today, memo: '' });

function formatNumber(n: number) {
  return new Intl.NumberFormat('ko-KR').format(n);
}

function isAutoTrade(t: any): boolean {
  return (t.memo || '').includes('자동매매') || (t.memo || '').includes('auto');
}

function getNetAmount(t: any): number {
  const amount = t.quantity * t.price;
  return t.type === 'BUY' ? amount + (t.fee || 0) : amount - (t.fee || 0);
}

const filteredTransactions = computed(() => {
  return transactions.value.filter(t => {
    if (filter.value.type && t.type !== filter.value.type) return false;
    if (filter.value.stockId && t.stock_id !== Number(filter.value.stockId)) return false;
    if (filter.value.source === 'paper' && !t.is_paper) return false;
    if (filter.value.source === 'real' && t.is_paper) return false;
    if (filter.value.source === 'auto' && (t.is_paper || !isAutoTrade(t))) return false;
    if (filter.value.source === 'manual' && (t.is_paper || isAutoTrade(t))) return false;
    return true;
  });
});

// 페이지네이션 — filteredTransactions 기준
const { page: txPage, pageSize: txPageSize, paged: pagedTransactions } = usePagination(filteredTransactions, 50);
// 필터 변경 시 1페이지로 리셋
watch(() => filter.value, () => { txPage.value = 1; }, { deep: true });

const stats = computed(() => {
  const all = transactions.value;
  return {
    buyCount: all.filter(t => t.type === 'BUY').length,
    sellCount: all.filter(t => t.type === 'SELL').length,
    totalFees: all.reduce((sum, t) => sum + (t.fee || 0), 0),
    autoCount: all.filter(t => isAutoTrade(t)).length,
  };
});

async function loadData() {
  const [stockRes, txRes, paperRes] = await Promise.all([
    stocksApi.getAll(),
    transactionsApi.getAll(),
    paperTradingApi.getHistory().catch(() => ({ data: [] })),
  ]);
  stocks.value = stockRes.data;
  // 실 transactions + 가상 paper_trades를 병합 — 날짜 desc 정렬
  const realTx = (txRes.data.transactions || []).map((t: any) => ({ ...t, is_paper: false }));
  const paperTx = (paperRes.data || []).map((p: any) => ({
    id: `paper-${p.id}`,
    is_paper: true,
    stock_id: p.stock_id,
    ticker: p.ticker,
    stock_name: p.name,
    type: p.order_type,
    quantity: p.quantity,
    price: p.price,
    fee: p.fee,
    date: (p.created_at || '').slice(0, 10),
    memo: `🧪 가상매매${p.reason ? ` (${p.reason})` : ''}${p.pnl != null ? ` · 손익 ${Math.round(p.pnl).toLocaleString()}원` : ''}`,
  }));
  transactions.value = [...realTx, ...paperTx].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function addTransaction() {
  formError.value = '';
  try {
    await transactionsApi.create({ ...form.value, stock_id: Number(form.value.stock_id) });
    form.value = { stock_id: '', type: 'BUY', quantity: 0, price: 0, fee: 0, date: today, memo: '' };
    showForm.value = false;
    loadData();
  } catch (err: any) {
    formError.value = err.response?.data?.error || '거래 추가 실패';
  }
}

async function deleteTransaction(id: number) {
  if (!confirm('이 거래를 삭제하시겠습니까?')) return;
  await transactionsApi.delete(id);
  loadData();
}

onMounted(loadData);
</script>
