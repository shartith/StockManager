<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-txt-primary">추천 종목</h2>
      <button @click="showAdd = true" class="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-hover transition">
        + 추천 추가
      </button>
    </div>

    <!-- 시장 탭 -->
    <div class="flex gap-1 mb-6 bg-surface-3 rounded-lg p-1 w-fit">
      <button v-for="m in markets" :key="m.value" @click="selectedMarket = m.value"
        class="px-4 py-2 rounded text-sm font-medium transition-colors"
        :class="selectedMarket === m.value ? 'bg-surface-1 text-txt-primary shadow-sm' : 'text-txt-secondary hover:text-txt-primary'">
        {{ m.label }}
      </button>
    </div>

    <!-- 추가 모달 -->
    <div v-if="showAdd" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" @click.self="showAdd = false">
      <div class="bg-surface-1 rounded-xl shadow-lg p-6 w-full max-w-md">
        <h3 class="text-lg font-bold text-txt-primary mb-4">추천 종목 추가</h3>
        <form @submit.prevent="addRecommendation" class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-txt-secondary mb-1">종목코드</label>
              <input v-model="addForm.ticker" type="text" required placeholder="005930"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label class="block text-xs font-medium text-txt-secondary mb-1">종목명</label>
              <input v-model="addForm.name" type="text" required placeholder="삼성전자"
                class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-txt-secondary mb-1">시장</label>
              <select v-model="addForm.market" class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="KRX">KRX</option>
                <option value="NYSE">NYSE</option>
                <option value="NASDAQ">NASDAQ</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-txt-secondary mb-1">신호</label>
              <select v-model="addForm.signal_type" class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="BUY">매수</option>
                <option value="SELL">매도</option>
                <option value="HOLD">관망</option>
              </select>
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-txt-secondary mb-1">추천 사유</label>
            <textarea v-model="addForm.reason" rows="2" placeholder="추천 근거를 입력하세요"
              class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"></textarea>
          </div>
          <div>
            <label class="block text-xs font-medium text-txt-secondary mb-1">신뢰도 ({{ addForm.confidence }}%)</label>
            <input v-model.number="addForm.confidence" type="range" min="0" max="100" class="w-full" />
          </div>
          <div class="flex gap-2 pt-2">
            <button type="submit" class="flex-1 bg-primary text-white py-2 rounded-lg text-sm hover:bg-primary-hover">추가</button>
            <button type="button" @click="showAdd = false" class="flex-1 bg-surface-3 text-txt-secondary py-2 rounded-lg text-sm hover:bg-surface-3">취소</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 추천 목록 -->
    <div v-if="loading" class="text-txt-tertiary text-sm">로딩 중...</div>
    <div v-else-if="filteredRecs.length === 0" class="text-center py-16 text-txt-tertiary">
      <p class="text-4xl mb-3">🔍</p>
      <p>{{ selectedMarket === 'ALL' ? '추천 종목이 없습니다' : `${selectedMarket} 추천 종목이 없습니다` }}</p>
    </div>
    <div v-else class="grid gap-4">
      <div v-for="rec in filteredRecs" :key="rec.id"
        class="bg-surface-1 rounded-xl border border-border shadow-sm p-5 hover:shadow-md transition">
        <div class="flex items-start gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="font-bold text-txt-primary">{{ rec.name }}</span>
              <span class="text-xs font-mono text-txt-tertiary">{{ rec.ticker }}</span>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                :class="rec.market === 'KRX' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'">
                {{ rec.market }}
              </span>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                :class="rec.signal_type === 'BUY' ? 'bg-red-50 text-red-700' : rec.signal_type === 'SELL' ? 'bg-blue-50 text-blue-700' : 'bg-surface-3 text-txt-secondary'">
                {{ rec.signal_type === 'BUY' ? '매수' : rec.signal_type === 'SELL' ? '매도' : '관망' }}
              </span>
              <span v-if="rec.score > 0" class="text-xs px-2 py-0.5 rounded-full font-bold"
                :class="rec.score >= 100 ? 'bg-red-100 text-red-700' : rec.score >= 80 ? 'bg-amber-100 text-amber-700' : 'bg-surface-3 text-txt-secondary'">
                {{ rec.score }}점
              </span>
            </div>
            <p v-if="rec.reason" class="text-sm text-txt-secondary mt-1">{{ rec.reason }}</p>
            <div class="flex items-center gap-3 mt-2 text-xs text-txt-tertiary">
              <span v-if="rec.confidence">신뢰도 {{ rec.confidence }}%</span>
              <span v-if="rec.source">출처: {{ rec.source }}</span>
              <span>{{ formatDate(rec.created_at) }}</span>
            </div>
          </div>
          <div class="flex flex-col gap-2 flex-shrink-0">
            <button @click="openChart(rec.ticker)"
              class="w-24 text-xs px-3 py-2 bg-surface-2 text-txt-primary rounded-lg hover:bg-surface-3 transition text-center whitespace-nowrap">
              차트
            </button>
            <button @click="addToWatchlist(rec)" class="w-24 text-xs px-3 py-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition text-center whitespace-nowrap">
              관심종목 추가
            </button>
            <button @click="dismissRec(rec.id)" class="w-24 text-xs px-3 py-2 bg-surface-2 text-txt-secondary rounded-lg hover:bg-surface-3 transition text-center whitespace-nowrap">
              제외
            </button>
          </div>
        </div>
        <!-- 신뢰도 바 -->
        <div v-if="rec.confidence" class="mt-3">
          <div class="h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all"
              :class="rec.confidence >= 70 ? 'bg-red-500' : rec.confidence >= 40 ? 'bg-amber-500' : 'bg-blue-500'"
              :style="{ width: `${rec.confidence}%` }"></div>
          </div>
        </div>
      </div>
    </div>
    <!-- 차트 모달 -->
    <ChartModal :visible="chartModalVisible" :ticker="chartModalTicker" @close="chartModalVisible = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { recommendationsApi } from '@/api';
import ChartModal from '@/components/ChartModal.vue';

const chartModalVisible = ref(false);
const chartModalTicker = ref('');
function openChart(ticker: string) {
  chartModalTicker.value = ticker;
  chartModalVisible.value = true;
}

const loading = ref(false);
const recommendations = ref<any[]>([]);
const selectedMarket = ref('ALL');
const showAdd = ref(false);

const markets = [
  { label: '전체', value: 'ALL' },
  { label: '🇰🇷 KRX', value: 'KRX' },
  { label: '🇺🇸 NYSE', value: 'NYSE' },
  { label: '🇺🇸 NASDAQ', value: 'NASDAQ' },
];

const addForm = ref({
  ticker: '', name: '', market: 'KRX', signal_type: 'BUY',
  reason: '', confidence: 70, source: 'manual',
});

const filteredRecs = computed(() => {
  if (selectedMarket.value === 'ALL') return recommendations.value;
  return recommendations.value.filter(r => r.market === selectedMarket.value);
});

function formatDate(dt: string) {
  return new Date(dt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function fetchRecs() {
  loading.value = true;
  try {
    const { data } = await recommendationsApi.getAll();
    recommendations.value = data;
  } catch { /* */ }
  finally { loading.value = false; }
}

async function addRecommendation() {
  try {
    await recommendationsApi.create(addForm.value);
    showAdd.value = false;
    addForm.value = { ticker: '', name: '', market: 'KRX', signal_type: 'BUY', reason: '', confidence: 70, source: 'manual' };
    await fetchRecs();
  } catch { /* */ }
}

async function addToWatchlist(rec: any) {
  try {
    await recommendationsApi.addToWatchlist(rec.id);
    await recommendationsApi.updateStatus(rec.id, 'EXECUTED');
    await fetchRecs();
  } catch { /* */ }
}

async function dismissRec(id: number) {
  try {
    await recommendationsApi.updateStatus(id, 'DISMISSED');
    await fetchRecs();
  } catch { /* */ }
}

onMounted(fetchRecs);
</script>
