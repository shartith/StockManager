<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-txt-primary">알림 설정</h2>
      <button @click="showForm = true" class="bg-primary text-white px-4 py-2 rounded-lg text-sm hover:bg-primary-hover transition">
        + 알림 추가
      </button>
    </div>

    <!-- 알림 추가 모달 -->
    <div v-if="showForm" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" @click.self="showForm = false">
      <div class="bg-surface-1 rounded-xl p-6 w-full max-w-md shadow-lg">
        <h3 class="text-lg font-bold mb-4">알림 추가</h3>
        <form @submit.prevent="addAlert" class="space-y-3">
          <div>
            <label class="block text-sm text-txt-secondary mb-1">종목 *</label>
            <select v-model="form.stock_id" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required>
              <option value="">선택하세요</option>
              <option v-for="s in stocks" :key="s.id" :value="s.id">{{ s.ticker }} - {{ s.name }}</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-txt-secondary mb-1">알림 유형 *</label>
            <select v-model="form.type" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required>
              <option value="PRICE_ABOVE">가격 이상 도달</option>
              <option value="PRICE_BELOW">가격 이하 하락</option>
              <option value="PROFIT_TARGET">목표 수익률 (%)</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-txt-secondary mb-1">
              {{ form.type === 'PROFIT_TARGET' ? '목표 수익률 (%)' : '목표 가격' }} *
            </label>
            <input v-model.number="form.value" type="number" step="any" class="w-full border border-border rounded-lg px-3 py-2 text-sm" required />
          </div>
          <div class="flex gap-2 pt-2">
            <button type="submit" class="flex-1 bg-primary text-white py-2 rounded-lg text-sm hover:bg-primary-hover">추가</button>
            <button type="button" @click="showForm = false" class="flex-1 bg-surface-3 text-txt-secondary py-2 rounded-lg text-sm hover:bg-surface-3">취소</button>
          </div>
        </form>
        <p v-if="formError" class="text-red-500 text-sm mt-2">{{ formError }}</p>
      </div>
    </div>

    <!-- 알림 목록 -->
    <div class="space-y-3">
      <div v-for="a in alerts" :key="a.id"
        class="bg-surface-1 rounded-xl shadow-sm border border-border p-4 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-full flex items-center justify-center text-lg"
            :class="a.is_active ? 'bg-blue-100' : 'bg-surface-3'">
            {{ a.type === 'PRICE_ABOVE' ? '📈' : a.type === 'PRICE_BELOW' ? '📉' : '🎯' }}
          </div>
          <div>
            <p class="font-medium text-txt-primary">
              {{ a.ticker }} <span class="text-txt-tertiary text-xs">{{ a.stock_name }}</span>
            </p>
            <p class="text-sm text-txt-secondary">
              {{ alertTypeLabel(a.type) }}: {{ a.type === 'PROFIT_TARGET' ? `${a.value}%` : formatNumber(a.value) }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button @click="toggleAlert(a.id, !a.is_active)"
            class="text-xs px-3 py-1 rounded-full"
            :class="a.is_active ? 'bg-green-100 text-green-700' : 'bg-surface-3 text-txt-secondary'">
            {{ a.is_active ? '활성' : '비활성' }}
          </button>
          <button @click="deleteAlert(a.id)" class="text-red-500 hover:text-red-700 text-xs">삭제</button>
        </div>
      </div>

      <div v-if="alerts.length === 0" class="text-center py-16 text-txt-tertiary">
        <p class="text-lg mb-1">설정된 알림이 없습니다</p>
        <p class="text-sm">가격 알림이나 목표 수익률 알림을 설정해보세요</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { stocksApi, alertsApi } from '@/api';

const stocks = ref<any[]>([]);
const alerts = ref<any[]>([]);
const showForm = ref(false);
const formError = ref('');
const form = ref({ stock_id: '', type: 'PRICE_ABOVE', value: 0 });

function alertTypeLabel(type: string) {
  const map: Record<string, string> = { PRICE_ABOVE: '가격 이상', PRICE_BELOW: '가격 이하', PROFIT_TARGET: '목표 수익률' };
  return map[type] || type;
}

function formatNumber(n: number) {
  return new Intl.NumberFormat('ko-KR').format(n);
}

async function loadData() {
  const [stockRes, alertRes] = await Promise.all([stocksApi.getAll(), alertsApi.getAll()]);
  stocks.value = stockRes.data;
  alerts.value = alertRes.data;
}

async function addAlert() {
  formError.value = '';
  try {
    await alertsApi.create({ ...form.value, stock_id: Number(form.value.stock_id) });
    form.value = { stock_id: '', type: 'PRICE_ABOVE', value: 0 };
    showForm.value = false;
    loadData();
  } catch (err: any) {
    formError.value = err.response?.data?.error || '알림 추가 실패';
  }
}

async function toggleAlert(id: number, active: boolean) {
  await alertsApi.toggle(id, active);
  loadData();
}

async function deleteAlert(id: number) {
  if (!confirm('이 알림을 삭제하시겠습니까?')) return;
  await alertsApi.delete(id);
  loadData();
}

onMounted(loadData);
</script>
