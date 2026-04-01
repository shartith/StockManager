<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-slate-800">배당금 관리</h2>
      <button @click="showForm = true" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition">
        + 배당금 추가
      </button>
    </div>

    <!-- 배당금 추가 모달 -->
    <div v-if="showForm" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <h3 class="text-lg font-bold mb-4">배당금 추가</h3>
        <form @submit.prevent="addDividend" class="space-y-3">
          <div>
            <label class="block text-sm text-slate-600 mb-1">종목 *</label>
            <select v-model="form.stock_id" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" required>
              <option value="">선택하세요</option>
              <option v-for="s in stocks" :key="s.id" :value="s.id">{{ s.ticker }} - {{ s.name }}</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-slate-600 mb-1">금액 *</label>
            <input v-model.number="form.amount" type="number" min="0" step="any" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" required />
          </div>
          <div>
            <label class="block text-sm text-slate-600 mb-1">날짜 *</label>
            <input v-model="form.date" type="date" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" required />
          </div>
          <div>
            <label class="block text-sm text-slate-600 mb-1">메모</label>
            <input v-model="form.memo" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div class="flex gap-2 pt-2">
            <button type="submit" class="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700">추가</button>
            <button type="button" @click="showForm = false" class="flex-1 bg-slate-100 text-slate-600 py-2 rounded-lg text-sm hover:bg-slate-200">취소</button>
          </div>
        </form>
        <p v-if="formError" class="text-red-500 text-sm mt-2">{{ formError }}</p>
      </div>
    </div>

    <!-- 배당금 요약 -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div class="bg-white rounded-xl shadow-sm p-5 border border-slate-200">
        <p class="text-xs font-medium text-slate-500">총 배당금</p>
        <p class="text-2xl font-bold text-blue-600 mt-2">{{ formatCurrency(totalDividends) }}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5 border border-slate-200">
        <p class="text-xs font-medium text-slate-500">올해 배당금</p>
        <p class="text-2xl font-bold text-slate-800 mt-2">{{ formatCurrency(yearDividends) }}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5 border border-slate-200">
        <p class="text-xs font-medium text-slate-500">배당 건수</p>
        <p class="text-2xl font-bold text-slate-800 mt-2">{{ dividends.length }}건</p>
      </div>
    </div>

    <!-- 배당금 내역 -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-200">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-slate-600">
            <tr>
              <th class="text-left px-4 py-3">날짜</th>
              <th class="text-left px-4 py-3">종목</th>
              <th class="text-right px-4 py-3">금액</th>
              <th class="text-left px-4 py-3">메모</th>
              <th class="text-center px-4 py-3">관리</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in dividends" :key="d.id" class="border-t border-slate-100 hover:bg-slate-50">
              <td class="px-4 py-3 text-slate-500">{{ d.date }}</td>
              <td class="px-4 py-3 font-medium">{{ d.ticker }} <span class="text-slate-400 text-xs">{{ d.stock_name }}</span></td>
              <td class="text-right px-4 py-3 font-medium text-blue-600">{{ formatCurrency(d.amount) }}</td>
              <td class="px-4 py-3 text-slate-400 text-xs">{{ d.memo || '-' }}</td>
              <td class="px-4 py-3 text-center">
                <button @click="deleteDividend(d.id)" class="text-red-500 hover:text-red-700 text-xs">삭제</button>
              </td>
            </tr>
            <tr v-if="dividends.length === 0">
              <td colspan="5" class="text-center py-8 text-slate-400">배당금 내역이 없습니다</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { stocksApi, dividendsApi } from '@/api';

const stocks = ref<any[]>([]);
const dividends = ref<any[]>([]);
const showForm = ref(false);
const formError = ref('');
const today = new Date().toISOString().split('T')[0];
const form = ref({ stock_id: '', amount: 0, date: today, memo: '' });

const totalDividends = computed(() => dividends.value.reduce((sum, d) => sum + d.amount, 0));
const yearDividends = computed(() => {
  const year = new Date().getFullYear().toString();
  return dividends.value.filter(d => d.date.startsWith(year)).reduce((sum, d) => sum + d.amount, 0);
});

function formatCurrency(v: number) {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(v);
}

async function loadData() {
  const [stockRes, divRes] = await Promise.all([stocksApi.getAll(), dividendsApi.getAll()]);
  stocks.value = stockRes.data;
  dividends.value = divRes.data;
}

async function addDividend() {
  formError.value = '';
  try {
    await dividendsApi.create({ ...form.value, stock_id: Number(form.value.stock_id) });
    form.value = { stock_id: '', amount: 0, date: today, memo: '' };
    showForm.value = false;
    loadData();
  } catch (err: any) {
    formError.value = err.response?.data?.error || '배당금 추가 실패';
  }
}

async function deleteDividend(id: number) {
  if (!confirm('이 배당금 기록을 삭제하시겠습니까?')) return;
  await dividendsApi.delete(id);
  loadData();
}

onMounted(loadData);
</script>
