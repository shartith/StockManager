<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-slate-800">대시보드</h2>
      <div class="flex gap-2">
        <!-- KIS 잔고 가져오기 버튼 -->
        <button
          v-if="kisConfigured"
          @click="showBalance = !showBalance"
          class="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-sm hover:bg-blue-100 transition"
        >
          💹 KIS 실시간 잔고
        </button>
        <button
          v-if="kisConfigured && store.summary?.holdings.length === 0"
          @click="importBalance"
          :disabled="importing"
          class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {{ importing ? '가져오는 중...' : '📥 계좌 잔고 가져오기' }}
        </button>
        <button @click="store.fetchSummary()" class="px-3 py-2 text-slate-500 hover:text-slate-700 text-sm">
          새로고침
        </button>
      </div>
    </div>

    <!-- KIS 실시간 잔고 패널 -->
    <div v-if="showBalance" class="mb-6">
      <div class="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 bg-blue-50 border-b border-blue-200">
          <h3 class="text-sm font-semibold text-blue-800">KIS 계좌 실시간 잔고</h3>
          <button @click="loadBalance" :disabled="balanceLoading" class="text-xs text-blue-600 hover:underline">
            {{ balanceLoading ? '조회 중...' : '새로고침' }}
          </button>
        </div>
        <div v-if="balanceError" class="p-4 text-sm text-red-600">{{ balanceError }}</div>
        <div v-else-if="balanceData">
          <!-- 계좌 요약 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 border-b border-slate-100">
            <div>
              <p class="text-xs text-slate-500">평가금액</p>
              <p class="font-bold text-slate-800">{{ formatCurrency(balanceData.totalEvalAmount) }}</p>
            </div>
            <div>
              <p class="text-xs text-slate-500">매입금액</p>
              <p class="font-bold text-slate-800">{{ formatCurrency(balanceData.totalPurchaseAmount) }}</p>
            </div>
            <div>
              <p class="text-xs text-slate-500">평가손익</p>
              <p class="font-bold" :class="balanceData.totalProfitLoss >= 0 ? 'text-red-600' : 'text-blue-600'">
                {{ formatCurrency(balanceData.totalProfitLoss) }}
              </p>
            </div>
            <div>
              <p class="text-xs text-slate-500">예수금</p>
              <p class="font-bold text-slate-800">{{ formatCurrency(balanceData.depositAmount) }}</p>
            </div>
          </div>
          <!-- 보유 종목 목록 -->
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 text-slate-600">
                <tr>
                  <th class="text-left px-4 py-2">종목</th>
                  <th class="text-right px-4 py-2">수량</th>
                  <th class="text-right px-4 py-2">평균단가</th>
                  <th class="text-right px-4 py-2">현재가</th>
                  <th class="text-right px-4 py-2">평가금액</th>
                  <th class="text-right px-4 py-2">수익률</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="h in balanceData.holdings" :key="h.ticker" class="border-t border-slate-100 hover:bg-slate-50">
                  <td class="px-4 py-2 font-medium">{{ h.ticker }} <span class="text-xs text-slate-400">{{ h.name }}</span></td>
                  <td class="text-right px-4 py-2">{{ h.quantity }}</td>
                  <td class="text-right px-4 py-2">{{ formatCurrency(h.avgPrice) }}</td>
                  <td class="text-right px-4 py-2">{{ formatCurrency(h.currentPrice) }}</td>
                  <td class="text-right px-4 py-2">{{ formatCurrency(h.totalValue) }}</td>
                  <td class="text-right px-4 py-2 font-medium" :class="h.profitLossRate >= 0 ? 'text-red-600' : 'text-blue-600'">
                    {{ h.profitLossRate >= 0 ? '+' : '' }}{{ h.profitLossRate.toFixed(2) }}%
                  </td>
                </tr>
                <tr v-if="balanceData.holdings.length === 0">
                  <td colspan="6" class="text-center py-6 text-slate-400">보유 종목 없음</td>
                </tr>
              </tbody>
            </table>
          </div>
          <!-- 해외 보유 종목 -->
          <div v-if="balanceData.overseasHoldings && balanceData.overseasHoldings.length > 0">
            <div class="px-5 py-3 bg-green-50 border-t border-b border-green-200">
              <h4 class="text-sm font-semibold text-green-800">해외 보유 종목</h4>
            </div>
            <!-- 해외 요약 -->
            <div class="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 border-b border-slate-100">
              <div>
                <p class="text-xs text-slate-500">해외 평가금액 (USD)</p>
                <p class="font-bold text-slate-800">{{ formatUsd(balanceData.overseasTotalEvalAmount) }}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500">해외 매입금액 (USD)</p>
                <p class="font-bold text-slate-800">{{ formatUsd(balanceData.overseasTotalPurchaseAmount) }}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500">해외 평가손익 (USD)</p>
                <p class="font-bold" :class="balanceData.overseasTotalProfitLoss >= 0 ? 'text-red-600' : 'text-blue-600'">
                  {{ formatUsd(balanceData.overseasTotalProfitLoss) }}
                </p>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="bg-slate-50 text-slate-600">
                  <tr>
                    <th class="text-left px-4 py-2">종목</th>
                    <th class="text-center px-4 py-2">거래소</th>
                    <th class="text-right px-4 py-2">수량</th>
                    <th class="text-right px-4 py-2">평균단가</th>
                    <th class="text-right px-4 py-2">현재가</th>
                    <th class="text-right px-4 py-2">평가금액</th>
                    <th class="text-right px-4 py-2">수익률</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="h in balanceData.overseasHoldings" :key="h.ticker" class="border-t border-slate-100 hover:bg-slate-50">
                    <td class="px-4 py-2 font-medium">{{ h.ticker }} <span class="text-xs text-slate-400">{{ h.name }}</span></td>
                    <td class="text-center px-4 py-2 text-xs text-slate-500">{{ h.market }}</td>
                    <td class="text-right px-4 py-2">{{ h.quantity }}</td>
                    <td class="text-right px-4 py-2">{{ formatUsd(h.avgPrice) }}</td>
                    <td class="text-right px-4 py-2">{{ formatUsd(h.currentPrice) }}</td>
                    <td class="text-right px-4 py-2">{{ formatUsd(h.totalValue) }}</td>
                    <td class="text-right px-4 py-2 font-medium" :class="h.profitLossRate >= 0 ? 'text-red-600' : 'text-blue-600'">
                      {{ h.profitLossRate >= 0 ? '+' : '' }}{{ h.profitLossRate.toFixed(2) }}%
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <!-- 가져오기 버튼 -->
          <div v-if="balanceData.holdings.length > 0 || (balanceData.overseasHoldings && balanceData.overseasHoldings.length > 0)" class="p-4 border-t border-slate-100 text-right">
            <button @click="importBalance" :disabled="importing"
              class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
              {{ importing ? '가져오는 중...' : `📥 ${balanceData.holdings.length + (balanceData.overseasHoldings?.length || 0)}개 종목을 포트폴리오로 가져오기` }}
            </button>
          </div>
        </div>
        <div v-else-if="balanceLoading" class="p-6 text-center text-slate-400 text-sm">잔고 조회 중...</div>
      </div>
    </div>

    <!-- 가져오기 결과 알림 -->
    <div v-if="importResult" class="mb-4 p-4 rounded-xl border text-sm"
      :class="importResult.error ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'">
      {{ importResult.error || importResult.message }}
      <span v-if="importResult.imported?.length" class="ml-2 text-xs opacity-70">
        ({{ importResult.imported.join(', ') }})
      </span>
    </div>

    <!-- 시스템 상태 패널 -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold text-slate-500">스케줄러</h4>
          <span class="w-2 h-2 rounded-full" :class="systemStatus.schedulerActive ? 'bg-green-500' : 'bg-slate-300'"></span>
        </div>
        <p class="text-sm font-bold mt-1" :class="systemStatus.schedulerActive ? 'text-green-700' : 'text-slate-400'">
          {{ systemStatus.schedulerActive ? `활성 (${systemStatus.taskCount}개 작업)` : '비활성' }}
        </p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold text-slate-500">Ollama (LLM)</h4>
          <span class="w-2 h-2 rounded-full" :class="systemStatus.ollamaConnected ? 'bg-green-500' : 'bg-slate-300'"></span>
        </div>
        <p class="text-sm font-bold mt-1" :class="systemStatus.ollamaConnected ? 'text-green-700' : 'text-slate-400'">
          {{ systemStatus.ollamaConnected ? '연결됨' : '미연결' }}
        </p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <h4 class="text-xs font-semibold text-slate-500">오늘의 매매 신호</h4>
        <div class="flex gap-3 mt-1">
          <span class="text-sm font-bold text-red-600">매수 {{ systemStatus.todayBuy }}건</span>
          <span class="text-sm font-bold text-blue-600">매도 {{ systemStatus.todaySell }}건</span>
          <span class="text-sm font-bold text-slate-400">관망 {{ systemStatus.todayHold }}건</span>
        </div>
      </div>
    </div>

    <div v-if="store.loading" class="text-slate-500">로딩 중...</div>
    <div v-else-if="store.error" class="text-red-500">{{ store.error }}</div>

    <template v-else-if="store.summary">
      <!-- 요약 카드 -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard label="총 투자금액" :value="formatCurrency(store.summary.totalInvested)" />
        <SummaryCard label="현재 평가금액" :value="formatCurrency(store.summary.totalCurrentValue)" />
        <SummaryCard
          label="총 수익/손실"
          :value="formatCurrency(store.summary.totalProfitLoss)"
          :sub="`${store.summary.totalProfitLossPercent >= 0 ? '+' : ''}${store.summary.totalProfitLossPercent}%`"
          :color="store.summary.totalProfitLoss >= 0 ? 'text-profit' : 'text-loss'"
        />
        <SummaryCard label="총 배당금" :value="formatCurrency(store.summary.totalDividends)" color="text-blue-600" />
      </div>

      <!-- 차트 영역 -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div class="bg-white rounded-xl shadow-sm p-5 border border-slate-200">
          <h3 class="text-sm font-semibold text-slate-600 mb-4">
            자산 배분
            <span class="text-xs font-normal text-slate-400 ml-1">
              {{ store.summary.allocationBy === 'sector' ? '섹터별' : '종목별' }}
            </span>
          </h3>
          <AllocationChart v-if="store.summary.allocation.length > 0" :data="store.summary.allocation" />
          <p v-else class="text-slate-400 text-sm">데이터가 없습니다</p>
        </div>
        <div class="bg-white rounded-xl shadow-sm p-5 border border-slate-200">
          <h3 class="text-sm font-semibold text-slate-600 mb-4">보유 종목 수익률</h3>
          <StockChart v-if="store.summary.holdings.length > 0" :holdings="store.summary.holdings" />
          <p v-else class="text-slate-400 text-sm">데이터가 없습니다</p>
        </div>
      </div>

      <!-- 보유 종목 테이블 -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-200">
        <div class="p-5 border-b border-slate-200">
          <h3 class="text-sm font-semibold text-slate-600">보유 종목 현황</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-slate-600">
              <tr>
                <th class="text-left px-4 py-3">종목</th>
                <th class="text-right px-4 py-3">수량</th>
                <th class="text-right px-4 py-3">평균단가</th>
                <th class="text-right px-4 py-3">현재가</th>
                <th class="text-right px-4 py-3">평가금액</th>
                <th class="text-right px-4 py-3">수익/손실</th>
                <th class="text-right px-4 py-3">수익률</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in store.summary.holdings" :key="h.stockId" class="border-t border-slate-100 hover:bg-slate-50">
                <td class="px-4 py-3">
                  <div class="font-medium text-slate-800">{{ h.ticker }}</div>
                  <div class="text-xs text-slate-400">{{ h.name }}</div>
                </td>
                <td class="text-right px-4 py-3">{{ h.quantity }}</td>
                <td class="text-right px-4 py-3">{{ formatCurrency(h.avgPrice) }}</td>
                <td class="text-right px-4 py-3">{{ h.currentPrice ? formatCurrency(h.currentPrice) : '-' }}</td>
                <td class="text-right px-4 py-3">{{ h.currentValue ? formatCurrency(h.currentValue) : formatCurrency(h.totalCost) }}</td>
                <td class="text-right px-4 py-3" :class="(h.profitLoss ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                  {{ h.profitLoss !== undefined ? formatCurrency(h.profitLoss) : '-' }}
                </td>
                <td class="text-right px-4 py-3" :class="(h.profitLossPercent ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                  {{ h.profitLossPercent !== undefined ? `${h.profitLossPercent >= 0 ? '+' : ''}${h.profitLossPercent}%` : '-' }}
                </td>
              </tr>
              <tr v-if="store.summary.holdings.length === 0">
                <td colspan="7" class="text-center py-12 text-slate-400">
                  <p class="mb-2">보유 종목이 없습니다.</p>
                  <p v-if="kisConfigured" class="text-xs">
                    상단 <strong>📥 계좌 잔고 가져오기</strong> 버튼으로 KIS 계좌에서 바로 불러올 수 있습니다.
                  </p>
                  <p v-else class="text-xs">
                    <router-link to="/settings" class="text-blue-500 underline">설정</router-link>에서 KIS API를 연결하거나,
                    <router-link to="/transactions" class="text-blue-500 underline">거래 내역</router-link>에서 직접 추가하세요.
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { usePortfolioStore } from '@/stores/portfolio';
import { chartApi, schedulerApi, analysisApi } from '@/api';
import SummaryCard from '@/components/SummaryCard.vue';
import AllocationChart from '@/components/AllocationChart.vue';
import StockChart from '@/components/StockChart.vue';

const store = usePortfolioStore();
const kisConfigured = ref(false);
const showBalance = ref(false);
const balanceData = ref<any>(null);
const balanceLoading = ref(false);
const balanceError = ref('');
const importing = ref(false);
const importResult = ref<any>(null);
const systemStatus = ref({
  schedulerActive: false,
  taskCount: 0,
  ollamaConnected: false,
  todayBuy: 0,
  todaySell: 0,
  todayHold: 0,
});

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

async function checkKisConfig() {
  try {
    const { data } = await chartApi.getConfig();
    kisConfigured.value = data.configured && data.hasAccount;
  } catch {
    kisConfigured.value = false;
  }
}

async function loadBalance() {
  balanceLoading.value = true;
  balanceError.value = '';
  try {
    const { data } = await chartApi.getBalance();
    balanceData.value = data;
  } catch (err: any) {
    balanceError.value = err.response?.data?.error || '잔고 조회 실패';
  } finally {
    balanceLoading.value = false;
  }
}

async function importBalance() {
  importing.value = true;
  importResult.value = null;
  try {
    const { data } = await chartApi.importBalance();
    importResult.value = data;
    showBalance.value = false;
    await store.fetchSummary();
    setTimeout(() => { importResult.value = null; }, 5000);
  } catch (err: any) {
    importResult.value = { error: err.response?.data?.error || '가져오기 실패' };
  } finally {
    importing.value = false;
  }
}

import { watch } from 'vue';
watch(showBalance, (val) => {
  if (val && !balanceData.value) loadBalance();
});

async function loadSystemStatus() {
  try {
    const { data } = await schedulerApi.getStatus();
    systemStatus.value.schedulerActive = data.active;
    systemStatus.value.taskCount = data.taskCount;
    // 오늘의 신호 카운트 (로그에서 추출)
    if (data.recentLogs) {
      const today = new Date().toISOString().slice(0, 10);
      const todayLogs = data.recentLogs.filter((l: any) => l.timestamp?.startsWith(today));
      systemStatus.value.todayBuy = todayLogs.filter((l: any) => l.message?.includes('BUY')).length;
      systemStatus.value.todaySell = todayLogs.filter((l: any) => l.message?.includes('SELL')).length;
      systemStatus.value.todayHold = todayLogs.filter((l: any) => l.message?.includes('HOLD')).length;
    }
  } catch { /* */ }

  try {
    const { data } = await analysisApi.getOllamaStatus();
    systemStatus.value.ollamaConnected = data.connected;
  } catch { /* */ }
}

onMounted(async () => {
  await checkKisConfig();
  store.fetchSummary();
  loadSystemStatus();
});
</script>
