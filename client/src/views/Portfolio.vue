<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-slate-800">포트폴리오</h2>
      <button @click="loadPortfolio" :disabled="loading" class="px-3 py-2 text-slate-500 hover:text-slate-700 text-sm">
        {{ loading ? '조회 중...' : '새로고침' }}
      </button>
    </div>

    <!-- 요약 카드 -->
    <div v-if="summary" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <p class="text-xs text-slate-500 mb-1">총 투자금</p>
        <p class="text-xl font-bold text-slate-800">{{ formatCurrency(summary.totalInvested) }}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <p class="text-xs text-slate-500 mb-1">평가금액</p>
        <p class="text-xl font-bold text-slate-800">{{ formatCurrency(summary.totalCurrentValue) }}</p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <p class="text-xs text-slate-500 mb-1">평가손익</p>
        <p class="text-xl font-bold" :class="summary.totalProfitLoss >= 0 ? 'text-red-600' : 'text-blue-600'">
          {{ summary.totalProfitLoss >= 0 ? '+' : '' }}{{ formatCurrency(summary.totalProfitLoss) }}
          <span class="text-sm font-normal">({{ summary.totalProfitLossPercent >= 0 ? '+' : '' }}{{ summary.totalProfitLossPercent }}%)</span>
        </p>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <p class="text-xs text-slate-500 mb-1">총 배당금 / 수수료</p>
        <p class="text-lg font-bold text-slate-800">
          {{ formatCurrency(summary.totalDividends) }}
          <span class="text-sm font-normal text-slate-400">/ -{{ formatCurrency(summary.totalFees) }}</span>
        </p>
      </div>
    </div>

    <!-- 보유 종목 목록 -->
    <div v-if="loading" class="text-slate-400 text-sm py-8 text-center">로딩 중...</div>
    <div v-else-if="!summary || summary.holdings.length === 0" class="text-center py-16 text-slate-400">
      <p class="text-4xl mb-3">💼</p>
      <p>보유 중인 종목이 없습니다</p>
      <p class="text-xs mt-1">거래 내역에서 매수를 등록하거나 자동매매로 매수하세요</p>
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <table class="w-full text-sm table-fixed">
        <colgroup>
          <col style="width: 130px" />
          <col style="width: 55px" />
          <col style="width: 55px" />
          <col style="width: 85px" />
          <col style="width: 85px" />
          <col style="width: 90px" />
          <col style="width: 90px" />
          <col style="width: 100px" />
          <col style="width: 80px" />
          <col style="width: 80px" />
        </colgroup>
        <thead>
          <tr class="text-left text-xs text-slate-500 border-b border-slate-100 bg-slate-50">
            <th class="px-4 py-3 whitespace-nowrap">종목</th>
            <th class="px-4 py-3 whitespace-nowrap">시장</th>
            <th class="px-4 py-3 whitespace-nowrap text-right">수량</th>
            <th class="px-4 py-3 whitespace-nowrap text-right">평균단가</th>
            <th class="px-4 py-3 whitespace-nowrap text-right">현재가</th>
            <th class="px-4 py-3 whitespace-nowrap text-right">투자금</th>
            <th class="px-4 py-3 whitespace-nowrap text-right">평가금</th>
            <th class="px-4 py-3 whitespace-nowrap text-right">손익</th>
            <th class="px-4 py-3 whitespace-nowrap text-center">AI 판단</th>
            <th class="px-4 py-3 whitespace-nowrap text-center">매매</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in summary.holdings" :key="h.stockId"
            class="border-b border-slate-50 hover:bg-slate-50">
            <td class="px-4 py-3">
              <p class="font-medium text-slate-800 truncate" :title="h.name">{{ h.name }}</p>
              <p class="text-xs text-slate-400">{{ h.ticker }}</p>
            </td>
            <td class="px-4 py-3">
              <span class="px-2 py-0.5 rounded text-xs font-medium"
                :class="{
                  'bg-blue-50 text-blue-700': h.market === 'KRX',
                  'bg-green-50 text-green-700': h.market === 'NYSE',
                  'bg-purple-50 text-purple-700': h.market === 'NASDAQ',
                  'bg-slate-100 text-slate-500': !h.market,
                }">
                {{ h.market || '-' }}
              </span>
            </td>
            <td class="px-4 py-3 text-right text-slate-700 font-medium">{{ h.quantity }}</td>
            <td class="px-4 py-3 text-right text-slate-600">{{ formatNum(h.avgPrice) }}</td>
            <td class="px-4 py-3 text-right text-slate-700 font-medium">
              {{ h.currentPrice ? formatNum(h.currentPrice) : '-' }}
            </td>
            <td class="px-4 py-3 text-right text-slate-600">{{ formatCurrency(h.totalCost) }}</td>
            <td class="px-4 py-3 text-right text-slate-700 font-medium">
              {{ h.currentValue ? formatCurrency(h.currentValue) : '-' }}
            </td>
            <td class="px-4 py-3 text-right">
              <template v-if="h.profitLoss !== undefined">
                <p class="font-bold" :class="h.profitLoss >= 0 ? 'text-red-600' : 'text-blue-600'">
                  {{ h.profitLoss >= 0 ? '+' : '' }}{{ formatCurrency(h.profitLoss) }}
                </p>
                <p class="text-xs" :class="h.profitLossPercent >= 0 ? 'text-red-500' : 'text-blue-500'">
                  {{ h.profitLossPercent >= 0 ? '+' : '' }}{{ h.profitLossPercent }}%
                </p>
              </template>
              <span v-else class="text-slate-400">-</span>
            </td>
            <td class="px-4 py-3 text-center">
              <template v-if="h.latestSignal">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                  :class="h.latestSignal === 'BUY' ? 'bg-red-50 text-red-700' : h.latestSignal === 'SELL' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'">
                  {{ h.latestSignal === 'BUY' ? '매수' : h.latestSignal === 'SELL' ? '매도' : '관망' }}
                </span>
                <p v-if="h.latestConfidence" class="text-xs text-slate-400 mt-0.5">{{ h.latestConfidence }}%</p>
              </template>
              <span v-else class="text-xs text-slate-300">-</span>
            </td>
            <td class="px-4 py-3">
              <div class="flex flex-col gap-1 items-center">
                <button @click="openChart(h.ticker)"
                  class="w-16 px-2 py-1 rounded text-xs font-medium bg-slate-50 text-slate-700 hover:bg-slate-100 transition">
                  차트
                </button>
                <button @click="runAnalysis(h)"
                  class="w-16 px-2 py-1 rounded text-xs font-medium bg-purple-50 text-purple-700 hover:bg-purple-100 transition">
                  분석
                </button>
                <button @click="openTradeModal(h, 'BUY')"
                  class="w-16 px-2 py-1 rounded text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 transition">
                  추가매수
                </button>
                <button @click="openTradeModal(h, 'SELL')"
                  class="w-16 px-2 py-1 rounded text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 transition">
                  매도
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 자산 배분 -->
    <div v-if="summary && summary.allocation.length > 1" class="mt-6 bg-white rounded-xl border border-slate-200 p-5">
      <h3 class="font-semibold text-slate-800 mb-4">자산 배분</h3>
      <div class="flex gap-0.5 h-6 rounded-full overflow-hidden bg-slate-100 mb-3">
        <div v-for="(a, i) in summary.allocation" :key="a.label"
          class="h-full transition-all"
          :class="ALLOC_COLORS[i % ALLOC_COLORS.length]"
          :style="{ width: a.percent + '%' }"
          :title="`${a.label}: ${a.percent}%`">
        </div>
      </div>
      <div class="flex flex-wrap gap-4">
        <div v-for="(a, i) in summary.allocation" :key="a.label" class="flex items-center gap-2">
          <span class="w-3 h-3 rounded-full" :class="ALLOC_COLORS[i % ALLOC_COLORS.length]"></span>
          <span class="text-sm text-slate-600">{{ a.label }}</span>
          <span class="text-sm font-medium text-slate-800">{{ a.percent }}%</span>
        </div>
      </div>
    </div>

    <!-- 포트폴리오 인사이트 (MPT + 상관관계) -->
    <div v-if="portfolioInsight" class="mt-6 space-y-4">
      <!-- 상관관계 경고 -->
      <div v-if="portfolioInsight.highCorrelationPairs?.length > 0" class="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <h4 class="text-sm font-semibold text-amber-800 mb-2">높은 상관관계 종목</h4>
        <div v-for="p in portfolioInsight.highCorrelationPairs" :key="p.pair" class="text-xs text-amber-700">
          {{ p.pair }} (r={{ p.correlation }}) — 사실상 동일 포지션, 분산 부족
        </div>
      </div>

      <!-- MPT 최적 비중 -->
      <div v-if="portfolioInsight.optimalWeights?.some((w: any) => w.action !== 'HOLD')" class="bg-white rounded-xl border border-slate-200 p-4">
        <h4 class="text-sm font-semibold text-slate-800 mb-3">MPT 최적 비중 제안</h4>
        <div class="space-y-2">
          <div v-for="w in portfolioInsight.optimalWeights.filter((w: any) => w.action !== 'HOLD')" :key="w.ticker"
            class="flex items-center justify-between text-sm">
            <span class="font-medium text-slate-700">{{ w.ticker }}</span>
            <div class="flex items-center gap-2">
              <span class="text-slate-400">{{ w.currentPercent }}%</span>
              <span class="text-slate-300">→</span>
              <span class="font-medium" :class="w.action === 'INCREASE' ? 'text-red-600' : 'text-blue-600'">
                {{ w.optimalPercent }}%
              </span>
              <span class="text-xs px-1.5 py-0.5 rounded"
                :class="w.action === 'INCREASE' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'">
                {{ w.action === 'INCREASE' ? '비중 확대' : '비중 축소' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 차트 모달 -->
    <ChartModal :visible="chartModalVisible" :ticker="chartModalTicker" @close="chartModalVisible = false" />

    <!-- 분석 모달 -->
    <div v-if="analysisModalVisible" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="analysisModalVisible = false">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between px-5 py-3 border-b border-slate-200 sticky top-0 bg-white">
          <span class="font-bold text-slate-800">{{ analysisTarget?.name || analysisTarget?.ticker }} 분석</span>
          <button @click="analysisModalVisible = false" class="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
        </div>
        <div v-if="analysisLoading" class="p-8 text-center text-slate-400">분석 중...</div>
        <div v-else-if="analysisResult" class="p-5 space-y-4">
          <!-- 기술적 지표 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div class="bg-slate-50 rounded-lg p-3 text-center">
              <p class="text-xs text-slate-500">RSI(14)</p>
              <p class="font-bold" :class="analysisResult.indicators?.rsi14 < 30 ? 'text-red-600' : analysisResult.indicators?.rsi14 > 70 ? 'text-blue-600' : 'text-slate-800'">
                {{ analysisResult.indicators?.rsi14?.toFixed(1) ?? '-' }}
              </p>
            </div>
            <div class="bg-slate-50 rounded-lg p-3 text-center">
              <p class="text-xs text-slate-500">MACD</p>
              <p class="font-bold text-slate-800">{{ analysisResult.indicators?.macd?.toFixed(1) ?? '-' }}</p>
            </div>
            <div class="bg-slate-50 rounded-lg p-3 text-center">
              <p class="text-xs text-slate-500">VWAP</p>
              <p class="font-bold text-slate-800">{{ analysisResult.indicators?.vwap?.toLocaleString() ?? '-' }}</p>
            </div>
            <div class="bg-slate-50 rounded-lg p-3 text-center">
              <p class="text-xs text-slate-500">ATR(14)</p>
              <p class="font-bold text-slate-800">{{ analysisResult.indicators?.atr14?.toFixed(0) ?? '-' }}</p>
            </div>
          </div>
          <!-- 종합 신호 -->
          <div class="rounded-lg p-4"
            :class="analysisResult.indicators?.signal === 'BUY' ? 'bg-red-50 border border-red-200' : analysisResult.indicators?.signal === 'SELL' ? 'bg-blue-50 border border-blue-200' : 'bg-slate-50 border border-slate-200'">
            <p class="text-sm font-bold"
              :class="analysisResult.indicators?.signal === 'BUY' ? 'text-red-700' : analysisResult.indicators?.signal === 'SELL' ? 'text-blue-700' : 'text-slate-700'">
              종합 신호: {{ analysisResult.indicators?.signal === 'BUY' ? '매수' : analysisResult.indicators?.signal === 'SELL' ? '매도' : '관망' }}
            </p>
            <ul class="text-xs text-slate-600 mt-2 space-y-0.5">
              <li v-for="r in (analysisResult.indicators?.signalReasons || [])" :key="r">{{ r }}</li>
            </ul>
          </div>
          <!-- 상세 지표 -->
          <div class="text-xs text-slate-500 space-y-1">
            <p>SMA: 5={{ analysisResult.indicators?.sma5?.toLocaleString() }} | 20={{ analysisResult.indicators?.sma20?.toLocaleString() }} | 60={{ analysisResult.indicators?.sma60?.toLocaleString() }}</p>
            <p>볼린저: 상={{ analysisResult.indicators?.bollingerUpper?.toLocaleString() }} | 하={{ analysisResult.indicators?.bollingerLower?.toLocaleString() }}</p>
            <p>데이터: {{ analysisResult.dataPoints }}개 캔들</p>
          </div>
        </div>
        <div v-else-if="analysisError" class="p-8 text-center text-red-500 text-sm">{{ analysisError }}</div>
      </div>
    </div>

    <!-- 매매 모달 -->
    <div v-if="showTradeModal" class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" @click.self="showTradeModal = false">
      <div class="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <h3 class="text-lg font-bold mb-1">
          {{ tradeForm.type === 'BUY' ? '추가 매수' : '매도' }}
        </h3>
        <p class="text-sm text-slate-500 mb-4">{{ tradeTarget?.name }} ({{ tradeTarget?.ticker }})</p>

        <!-- 보유 현황 -->
        <div class="bg-slate-50 rounded-lg p-3 mb-4 text-sm">
          <div class="flex justify-between">
            <span class="text-slate-500">보유 수량</span>
            <span class="font-medium">{{ tradeTarget?.quantity }}주</span>
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-slate-500">평균 단가</span>
            <span class="font-medium">{{ formatNum(tradeTarget?.avgPrice || 0) }}</span>
          </div>
          <div v-if="tradeTarget?.currentPrice" class="flex justify-between mt-1">
            <span class="text-slate-500">현재가</span>
            <span class="font-medium">{{ formatNum(tradeTarget.currentPrice) }}</span>
          </div>
        </div>

        <form @submit.prevent="submitTrade" class="space-y-3">
          <!-- 매도 시 빠른 비율 버튼 -->
          <div v-if="tradeForm.type === 'SELL'" class="flex gap-2">
            <button type="button" v-for="pct in [25, 50, 75, 100]" :key="pct"
              @click="setQuantityPercent(pct)"
              class="flex-1 py-1.5 rounded text-xs font-medium border transition"
              :class="getQuantityForPercent(pct) === tradeForm.quantity
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'">
              {{ pct }}%
            </button>
          </div>

          <div>
            <label class="block text-sm text-slate-600 mb-1">수량 *</label>
            <input v-model.number="tradeForm.quantity" type="number" min="1"
              :max="tradeForm.type === 'SELL' ? tradeTarget?.quantity : undefined"
              class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" required />
            <p v-if="tradeForm.type === 'SELL'" class="text-xs text-slate-400 mt-1">
              최대 {{ tradeTarget?.quantity }}주
            </p>
          </div>
          <div>
            <label class="block text-sm text-slate-600 mb-1">가격 *</label>
            <input v-model.number="tradeForm.price" type="number" min="0" step="any"
              class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" required />
            <button v-if="tradeTarget?.currentPrice" type="button"
              @click="tradeForm.price = tradeTarget.currentPrice"
              class="text-xs text-blue-600 hover:underline mt-1">현재가 적용</button>
          </div>
          <div>
            <label class="block text-sm text-slate-600 mb-1">수수료</label>
            <input v-model.number="tradeForm.fee" type="number" min="0" step="any"
              class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-sm text-slate-600 mb-1">메모</label>
            <input v-model="tradeForm.memo" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              :placeholder="tradeForm.type === 'BUY' ? '추가 매수 사유' : '매도 사유 (이익실현, 손절 등)'" />
          </div>

          <!-- 예상 금액 -->
          <div v-if="tradeForm.quantity > 0 && tradeForm.price > 0" class="bg-slate-50 rounded-lg p-3 text-sm">
            <div class="flex justify-between">
              <span class="text-slate-500">{{ tradeForm.type === 'BUY' ? '매수 금액' : '매도 금액' }}</span>
              <span class="font-bold text-slate-800">{{ formatCurrency(tradeForm.quantity * tradeForm.price) }}</span>
            </div>
            <div v-if="tradeForm.type === 'SELL' && tradeTarget" class="flex justify-between mt-1">
              <span class="text-slate-500">예상 손익</span>
              <span class="font-bold"
                :class="(tradeForm.price - tradeTarget.avgPrice) >= 0 ? 'text-red-600' : 'text-blue-600'">
                {{ (tradeForm.price - tradeTarget.avgPrice) >= 0 ? '+' : '' }}{{ formatCurrency((tradeForm.price - tradeTarget.avgPrice) * tradeForm.quantity) }}
              </span>
            </div>
          </div>

          <div class="flex gap-2 pt-2">
            <button type="submit" :disabled="submitting"
              class="flex-1 py-2 rounded-lg text-sm font-medium transition"
              :class="tradeForm.type === 'BUY'
                ? 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
                : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'">
              {{ submitting ? '처리 중...' : (tradeForm.type === 'BUY' ? '매수 확인' : '매도 확인') }}
            </button>
            <button type="button" @click="showTradeModal = false"
              class="flex-1 bg-slate-100 text-slate-600 py-2 rounded-lg text-sm hover:bg-slate-200">
              취소
            </button>
          </div>
        </form>
        <p v-if="tradeError" class="text-red-500 text-sm mt-2">{{ tradeError }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { portfolioApi, transactionsApi, analysisApi } from '@/api';
import ChartModal from '@/components/ChartModal.vue';

// 차트 모달
const chartModalVisible = ref(false);
const chartModalTicker = ref('');
function openChart(ticker: string) {
  chartModalTicker.value = ticker;
  chartModalVisible.value = true;
}

// 분석 모달
const analysisModalVisible = ref(false);
const analysisTarget = ref<any>(null);
const analysisResult = ref<any>(null);
const analysisLoading = ref(false);
const analysisError = ref('');

async function runAnalysis(holding: any) {
  analysisTarget.value = holding;
  analysisModalVisible.value = true;
  analysisLoading.value = true;
  analysisResult.value = null;
  analysisError.value = '';
  try {
    const { data } = await analysisApi.getAnalysis(holding.ticker);
    analysisResult.value = data;
  } catch (err: any) {
    analysisError.value = err.response?.data?.error || '분석 실패';
  }
  analysisLoading.value = false;
}

const summary = ref<any>(null);
const loading = ref(false);
const portfolioInsight = ref<any>(null);

// 매매 모달
const showTradeModal = ref(false);
const tradeTarget = ref<any>(null);
const tradeForm = ref({ type: 'BUY' as 'BUY' | 'SELL', quantity: 0, price: 0, fee: 0, memo: '' });
const tradeError = ref('');
const submitting = ref(false);

const ALLOC_COLORS = [
  'bg-blue-500', 'bg-red-500', 'bg-green-500', 'bg-amber-500',
  'bg-purple-500', 'bg-cyan-500', 'bg-pink-500', 'bg-indigo-500',
];

function formatCurrency(value: number): string {
  if (value === undefined || value === null) return '-';
  return Math.round(value).toLocaleString();
}

function formatNum(value: number): string {
  if (value === undefined || value === null) return '-';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function openTradeModal(holding: any, type: 'BUY' | 'SELL') {
  tradeTarget.value = holding;
  tradeForm.value = {
    type,
    quantity: type === 'SELL' ? holding.quantity : 0,
    price: holding.currentPrice || 0,
    fee: 0,
    memo: '',
  };
  tradeError.value = '';
  showTradeModal.value = true;
}

function getQuantityForPercent(pct: number): number {
  if (!tradeTarget.value) return 0;
  return Math.floor(tradeTarget.value.quantity * pct / 100);
}

function setQuantityPercent(pct: number) {
  tradeForm.value.quantity = getQuantityForPercent(pct);
}

async function submitTrade() {
  if (tradeForm.value.quantity <= 0 || tradeForm.value.price <= 0) {
    tradeError.value = '수량과 가격을 입력하세요';
    return;
  }
  if (tradeForm.value.type === 'SELL' && tradeForm.value.quantity > tradeTarget.value.quantity) {
    tradeError.value = `보유 수량(${tradeTarget.value.quantity}주)을 초과할 수 없습니다`;
    return;
  }

  submitting.value = true;
  tradeError.value = '';
  try {
    await transactionsApi.create({
      stock_id: tradeTarget.value.stockId,
      type: tradeForm.value.type,
      quantity: tradeForm.value.quantity,
      price: tradeForm.value.price,
      fee: tradeForm.value.fee || 0,
      date: new Date().toISOString().split('T')[0],
      memo: tradeForm.value.memo,
    });
    showTradeModal.value = false;
    await loadPortfolio();
  } catch (err: any) {
    tradeError.value = err.response?.data?.error || '거래 처리 실패';
  }
  submitting.value = false;
}

async function loadPortfolio() {
  loading.value = true;
  try {
    const { data } = await portfolioApi.getSummary();
    summary.value = data;
  } catch { /* */ }
  try {
    const { data } = await portfolioApi.getInsight();
    portfolioInsight.value = data;
  } catch { /* */ }
  loading.value = false;
}

onMounted(loadPortfolio);
</script>
