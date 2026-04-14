<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-txt-primary">포트폴리오</h2>
        <p class="text-sm text-txt-tertiary mt-0.5">보유 종목 현황 및 매매</p>
      </div>
      <button @click="loadPortfolio" :disabled="loading"
        class="p-2 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-surface-2 transition-colors" aria-label="새로고침">
        <svg class="w-5 h-5" :class="{ 'animate-spin': loading }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <!-- 요약 카드 -->
    <div v-if="summary" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <SummaryCard label="총 투자금" :value="formatCurrency(summary.totalInvested)" :numeric-value="summary.totalInvested" format="currency" />
      <SummaryCard label="평가금액" :value="formatCurrency(summary.totalCurrentValue)" :numeric-value="summary.totalCurrentValue" format="currency" />
      <SummaryCard
        label="평가손익"
        :value="formatCurrency(summary.totalProfitLoss)"
        :numeric-value="summary.totalProfitLoss"
        format="currency"
        :show-sign="true"
        :change="summary.totalProfitLossPercent"
        :color="summary.totalProfitLoss >= 0 ? 'text-profit' : 'text-loss'"
      />
      <SummaryCard label="배당금 / 수수료" :value="formatCurrency(summary.totalDividends)" :sub="`수수료 -${formatCurrency(summary.totalFees)}`" />
    </div>

    <!-- 보유 종목 목록 -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
    </div>
    <div v-else-if="!summary || summary.holdings.length === 0" class="text-center py-16 text-txt-tertiary">
      <svg class="w-12 h-12 mx-auto mb-3 text-txt-tertiary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
      </svg>
      <p>보유 중인 종목이 없습니다</p>
      <p class="text-xs mt-1">거래 내역에서 매수를 등록하거나 자동매매로 매수하세요</p>
    </div>
    <div v-else class="solid-card overflow-hidden">
      <!-- Desktop 테이블 -->
      <div class="hidden md:block overflow-x-auto">
        <table class="table-modern">
          <thead>
            <tr>
              <th class="text-left" style="width: 130px">종목</th>
              <th class="text-left" style="width: 55px">시장</th>
              <th class="text-right" style="width: 55px">수량</th>
              <th class="text-right" style="width: 85px">평균단가</th>
              <th class="text-right" style="width: 85px">현재가</th>
              <th class="text-right" style="width: 90px">투자금</th>
              <th class="text-right" style="width: 90px">평가금</th>
              <th class="text-right" style="width: 100px">손익</th>
              <th class="text-center" style="width: 80px">AI 판단</th>
              <th class="text-center" style="width: 80px">매매</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in summary.holdings" :key="h.stockId">
              <td>
                <p class="font-medium text-txt-primary truncate" :title="h.name">{{ h.name }}</p>
                <p class="text-xs text-txt-tertiary">{{ h.ticker }}</p>
              </td>
              <td>
                <span class="px-2 py-0.5 rounded-md text-[10px] font-medium"
                  :class="{
                    'bg-accent-dim text-accent': h.market === 'KRX',
                    'bg-green-500/10 text-green-500': h.market === 'NYSE',
                    'bg-purple-500/10 text-purple-500': h.market === 'NASDAQ',
                    'bg-surface-2 text-txt-tertiary': !h.market,
                  }">
                  {{ h.market || '-' }}
                </span>
              </td>
              <td class="text-right tabular-nums font-medium">{{ h.quantity }}</td>
              <td class="text-right tabular-nums text-txt-secondary">{{ formatNum(h.avgPrice) }}</td>
              <td class="text-right tabular-nums font-medium">{{ h.currentPrice ? formatNum(h.currentPrice) : '-' }}</td>
              <td class="text-right tabular-nums text-txt-secondary">{{ formatCurrency(h.totalCost) }}</td>
              <td class="text-right tabular-nums font-medium">{{ h.currentValue ? formatCurrency(h.currentValue) : '-' }}</td>
              <td class="text-right">
                <template v-if="h.profitLoss !== undefined">
                  <p class="tabular-nums font-bold" :class="h.profitLoss >= 0 ? 'text-profit' : 'text-loss'">
                    {{ h.profitLoss >= 0 ? '+' : '' }}{{ formatCurrency(h.profitLoss) }}
                  </p>
                  <TrendBadge :value="h.profitLossPercent" class="mt-0.5" />
                </template>
                <span v-else class="text-txt-tertiary">-</span>
              </td>
              <td class="text-center">
                <template v-if="h.latestSignal">
                  <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                    :class="h.latestSignal === 'BUY' ? 'bg-profit text-white' : h.latestSignal === 'SELL' ? 'bg-loss text-white' : 'bg-surface-2 text-txt-secondary'">
                    {{ h.latestSignal === 'BUY' ? '매수' : h.latestSignal === 'SELL' ? '매도' : '관망' }}
                  </span>
                  <p v-if="h.latestConfidence" class="text-[10px] text-txt-tertiary mt-0.5">{{ h.latestConfidence }}%</p>
                </template>
                <span v-else class="text-xs text-txt-tertiary">-</span>
              </td>
              <td>
                <div class="flex flex-col gap-1 items-center">
                  <button @click="openChart(h.ticker)"
                    class="w-16 px-2 py-1 rounded-md text-xs font-medium bg-surface-2 text-txt-secondary hover:bg-surface-3 transition-colors">차트</button>
                  <button @click="runAnalysis(h)"
                    class="w-16 px-2 py-1 rounded-md text-xs font-medium bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors">분석</button>
                  <button @click="openTradeModal(h, 'BUY')"
                    class="w-16 px-2 py-1 rounded-md text-xs font-medium bg-profit/10 text-profit hover:bg-profit/20 transition-colors">추가매수</button>
                  <button @click="openTradeModal(h, 'SELL')"
                    class="w-16 px-2 py-1 rounded-md text-xs font-medium bg-loss/10 text-loss hover:bg-loss/20 transition-colors">매도</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Mobile 카드 리스트 -->
      <div class="md:hidden divide-y divide-border-subtle">
        <div v-for="h in summary.holdings" :key="h.stockId" class="p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-txt-primary">{{ h.name }}</p>
              <p class="text-xs text-txt-tertiary">{{ h.ticker }}
                <span v-if="h.market" class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-2">{{ h.market }}</span>
              </p>
            </div>
            <div class="text-right">
              <p class="font-bold tabular-nums" :class="(h.profitLoss ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                {{ h.profitLoss !== undefined ? `${h.profitLoss >= 0 ? '+' : ''}${formatCurrency(h.profitLoss)}` : '-' }}
              </p>
              <TrendBadge v-if="h.profitLossPercent !== undefined" :value="h.profitLossPercent" class="mt-0.5" />
            </div>
          </div>
          <div class="grid grid-cols-3 gap-3 text-xs">
            <div><span class="text-txt-tertiary">수량</span><p class="font-medium tabular-nums mt-0.5">{{ h.quantity }}</p></div>
            <div><span class="text-txt-tertiary">평균단가</span><p class="font-medium tabular-nums mt-0.5">{{ formatNum(h.avgPrice) }}</p></div>
            <div><span class="text-txt-tertiary">현재가</span><p class="font-medium tabular-nums mt-0.5">{{ h.currentPrice ? formatNum(h.currentPrice) : '-' }}</p></div>
          </div>
          <div class="flex gap-2">
            <button @click="openChart(h.ticker)" class="flex-1 py-1.5 rounded-md text-xs font-medium bg-surface-2 text-txt-secondary hover:bg-surface-3 transition-colors">차트</button>
            <button @click="runAnalysis(h)" class="flex-1 py-1.5 rounded-md text-xs font-medium bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors">분석</button>
            <button @click="openTradeModal(h, 'BUY')" class="flex-1 py-1.5 rounded-md text-xs font-medium bg-profit/10 text-profit hover:bg-profit/20 transition-colors">매수</button>
            <button @click="openTradeModal(h, 'SELL')" class="flex-1 py-1.5 rounded-md text-xs font-medium bg-loss/10 text-loss hover:bg-loss/20 transition-colors">매도</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 포트폴리오 히스토리 -->
    <div class="mt-6 glass-card p-5">
      <h3 class="font-semibold text-txt-primary mb-4">포트폴리오 히스토리</h3>
      <p class="text-xs text-txt-tertiary mb-3">거래 내역 기반 누적 순투자/수수료 추이</p>
      <div class="h-72"><PortfolioHistoryChart /></div>
    </div>

    <!-- 자산 배분 -->
    <div v-if="summary && summary.allocation.length > 1" class="mt-6 glass-card p-5">
      <h3 class="font-semibold text-txt-primary mb-4">자산 배분</h3>
      <div class="flex gap-0.5 h-2 rounded-full overflow-hidden bg-surface-2 mb-3">
        <div v-for="(a, i) in summary.allocation" :key="a.label"
          class="h-full transition-all duration-slow"
          :class="ALLOC_COLORS[i % ALLOC_COLORS.length]"
          :style="{ width: a.percent + '%' }"
          :title="`${a.label}: ${a.percent}%`">
        </div>
      </div>
      <div class="flex flex-wrap gap-4">
        <div v-for="(a, i) in summary.allocation" :key="a.label" class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full" :class="ALLOC_COLORS[i % ALLOC_COLORS.length]" />
          <span class="text-sm text-txt-secondary">{{ a.label }}</span>
          <span class="text-sm font-medium text-txt-primary tabular-nums">{{ a.percent }}%</span>
        </div>
      </div>
    </div>

    <!-- 포트폴리오 인사이트 -->
    <div v-if="portfolioInsight" class="mt-6 space-y-4">
      <div v-if="portfolioInsight.highCorrelationPairs?.length > 0" class="glass-card p-4 !border-amber-500/20">
        <h4 class="text-sm font-semibold text-amber-500 mb-2">높은 상관관계 종목</h4>
        <div v-for="p in portfolioInsight.highCorrelationPairs" :key="p.pair" class="text-xs text-txt-secondary">
          {{ p.pair }} (r={{ p.correlation }}) — 사실상 동일 포지션, 분산 부족
        </div>
      </div>

      <div v-if="portfolioInsight.optimalWeights?.some((w: any) => w.action !== 'HOLD')" class="glass-card p-4">
        <h4 class="text-sm font-semibold text-txt-primary mb-3">MPT 최적 비중 제안</h4>
        <div class="space-y-2">
          <div v-for="w in portfolioInsight.optimalWeights.filter((w: any) => w.action !== 'HOLD')" :key="w.ticker"
            class="flex items-center justify-between text-sm">
            <span class="font-medium text-txt-secondary">{{ w.ticker }}</span>
            <div class="flex items-center gap-2">
              <span class="text-txt-tertiary tabular-nums">{{ w.currentPercent }}%</span>
              <svg class="w-3 h-3 text-txt-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
              </svg>
              <span class="font-medium tabular-nums" :class="w.action === 'INCREASE' ? 'text-profit' : 'text-loss'">
                {{ w.optimalPercent }}%
              </span>
              <span class="text-xs px-1.5 py-0.5 rounded-md font-medium"
                :class="w.action === 'INCREASE' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'">
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
    <Transition name="fade">
      <div v-if="analysisModalVisible" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" @click.self="analysisModalVisible = false">
        <div class="bg-surface-1 rounded-2xl shadow-lg border border-border w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
          <div class="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface-1 z-10 rounded-t-2xl">
            <span class="font-bold text-txt-primary">{{ analysisTarget?.name || analysisTarget?.ticker }} 분석</span>
            <button @click="analysisModalVisible = false" class="text-txt-tertiary hover:text-txt-primary text-xl transition-colors">&times;</button>
          </div>
          <div v-if="analysisLoading" class="p-8 flex items-center justify-center">
            <div class="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
          <div v-else-if="analysisResult" class="p-5 space-y-4">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="glass-card p-3 text-center">
                <p class="text-xs text-txt-tertiary">RSI(14)</p>
                <p class="font-bold mt-1" :class="analysisResult.indicators?.rsi14 < 30 ? 'text-profit' : analysisResult.indicators?.rsi14 > 70 ? 'text-loss' : 'text-txt-primary'">
                  {{ analysisResult.indicators?.rsi14?.toFixed(1) ?? '-' }}
                </p>
              </div>
              <div class="glass-card p-3 text-center">
                <p class="text-xs text-txt-tertiary">MACD</p>
                <p class="font-bold text-txt-primary mt-1">{{ analysisResult.indicators?.macd?.toFixed(1) ?? '-' }}</p>
              </div>
              <div class="glass-card p-3 text-center">
                <p class="text-xs text-txt-tertiary">VWAP</p>
                <p class="font-bold text-txt-primary mt-1">{{ analysisResult.indicators?.vwap?.toLocaleString() ?? '-' }}</p>
              </div>
              <div class="glass-card p-3 text-center">
                <p class="text-xs text-txt-tertiary">ATR(14)</p>
                <p class="font-bold text-txt-primary mt-1">{{ analysisResult.indicators?.atr14?.toFixed(0) ?? '-' }}</p>
              </div>
            </div>
            <div class="rounded-xl p-4 border"
              :class="analysisResult.indicators?.signal === 'BUY' ? 'bg-profit/5 border-profit/20' : analysisResult.indicators?.signal === 'SELL' ? 'bg-loss/5 border-loss/20' : 'bg-surface-2 border-border'">
              <p class="text-sm font-bold"
                :class="analysisResult.indicators?.signal === 'BUY' ? 'text-profit' : analysisResult.indicators?.signal === 'SELL' ? 'text-loss' : 'text-txt-secondary'">
                종합 신호: {{ analysisResult.indicators?.signal === 'BUY' ? '매수' : analysisResult.indicators?.signal === 'SELL' ? '매도' : '관망' }}
              </p>
              <ul class="text-xs text-txt-secondary mt-2 space-y-0.5">
                <li v-for="r in (analysisResult.indicators?.signalReasons || [])" :key="r">{{ r }}</li>
              </ul>
            </div>
            <div class="text-xs text-txt-tertiary space-y-1">
              <p>SMA: 5={{ analysisResult.indicators?.sma5?.toLocaleString() }} | 20={{ analysisResult.indicators?.sma20?.toLocaleString() }} | 60={{ analysisResult.indicators?.sma60?.toLocaleString() }}</p>
              <p>볼린저: 상={{ analysisResult.indicators?.bollingerUpper?.toLocaleString() }} | 하={{ analysisResult.indicators?.bollingerLower?.toLocaleString() }}</p>
              <p>데이터: {{ analysisResult.dataPoints }}개 캔들</p>
            </div>
          </div>
          <div v-else-if="analysisError" class="p-8 text-center text-profit text-sm">{{ analysisError }}</div>
        </div>
      </div>
    </Transition>

    <!-- 매매 모달 -->
    <Transition name="fade">
      <div v-if="showTradeModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" @click.self="showTradeModal = false">
        <div class="bg-surface-1 rounded-2xl p-6 w-full max-w-md shadow-lg border border-border mx-4">
          <h3 class="text-lg font-bold text-txt-primary mb-1">
            {{ tradeForm.type === 'BUY' ? '추가 매수' : '매도' }}
          </h3>
          <p class="text-sm text-txt-secondary mb-4">{{ tradeTarget?.name }} ({{ tradeTarget?.ticker }})</p>

          <div class="bg-surface-2 rounded-xl p-3 mb-4 text-sm space-y-1">
            <div class="flex justify-between">
              <span class="text-txt-tertiary">보유 수량</span>
              <span class="font-medium tabular-nums">{{ tradeTarget?.quantity }}주</span>
            </div>
            <div class="flex justify-between">
              <span class="text-txt-tertiary">평균 단가</span>
              <span class="font-medium tabular-nums">{{ formatNum(tradeTarget?.avgPrice || 0) }}</span>
            </div>
            <div v-if="tradeTarget?.currentPrice" class="flex justify-between">
              <span class="text-txt-tertiary">현재가</span>
              <span class="font-medium tabular-nums">{{ formatNum(tradeTarget.currentPrice) }}</span>
            </div>
          </div>

          <form @submit.prevent="submitTrade" class="space-y-3">
            <div v-if="tradeForm.type === 'SELL'" class="flex gap-2">
              <button type="button" v-for="pct in [25, 50, 75, 100]" :key="pct"
                @click="setQuantityPercent(pct)"
                class="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                :class="getQuantityForPercent(pct) === tradeForm.quantity
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface-1 text-txt-secondary border-border hover:bg-surface-2'">
                {{ pct }}%
              </button>
            </div>

            <div>
              <label class="block text-sm text-txt-secondary mb-1">수량 *</label>
              <input v-model.number="tradeForm.quantity" type="number" min="1"
                :max="tradeForm.type === 'SELL' ? tradeTarget?.quantity : undefined"
                class="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm text-txt-primary
                       focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all" required />
            </div>
            <div>
              <label class="block text-sm text-txt-secondary mb-1">가격 *</label>
              <input v-model.number="tradeForm.price" type="number" min="0" step="any"
                class="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm text-txt-primary
                       focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all" required />
              <button v-if="tradeTarget?.currentPrice" type="button"
                @click="tradeForm.price = tradeTarget.currentPrice"
                class="text-xs text-accent hover:underline mt-1">현재가 적용</button>
            </div>
            <div>
              <label class="block text-sm text-txt-secondary mb-1">수수료</label>
              <input v-model.number="tradeForm.fee" type="number" min="0" step="any"
                class="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm text-txt-primary
                       focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all" />
            </div>
            <div>
              <label class="block text-sm text-txt-secondary mb-1">메모</label>
              <input v-model="tradeForm.memo"
                class="w-full bg-surface-2 border border-border rounded-xl px-3 py-2.5 text-sm text-txt-primary
                       focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all"
                :placeholder="tradeForm.type === 'BUY' ? '추가 매수 사유' : '매도 사유'" />
            </div>

            <div v-if="tradeForm.quantity > 0 && tradeForm.price > 0" class="bg-surface-2 rounded-xl p-3 text-sm space-y-1">
              <div class="flex justify-between">
                <span class="text-txt-tertiary">{{ tradeForm.type === 'BUY' ? '매수 금액' : '매도 금액' }}</span>
                <span class="font-bold text-txt-primary tabular-nums">{{ formatCurrency(tradeForm.quantity * tradeForm.price) }}</span>
              </div>
              <div v-if="tradeForm.type === 'SELL' && tradeTarget" class="flex justify-between">
                <span class="text-txt-tertiary">예상 손익</span>
                <span class="font-bold tabular-nums" :class="(tradeForm.price - tradeTarget.avgPrice) >= 0 ? 'text-profit' : 'text-loss'">
                  {{ (tradeForm.price - tradeTarget.avgPrice) >= 0 ? '+' : '' }}{{ formatCurrency((tradeForm.price - tradeTarget.avgPrice) * tradeForm.quantity) }}
                </span>
              </div>
            </div>

            <div class="flex gap-2 pt-2">
              <button type="submit" :disabled="submitting"
                class="flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors"
                :class="tradeForm.type === 'BUY'
                  ? 'bg-profit text-white hover:bg-red-700 disabled:opacity-50'
                  : 'bg-loss text-white hover:bg-blue-700 disabled:opacity-50'">
                {{ submitting ? '처리 중...' : (tradeForm.type === 'BUY' ? '매수 확인' : '매도 확인') }}
              </button>
              <button type="button" @click="showTradeModal = false"
                class="flex-1 bg-surface-2 text-txt-secondary py-2.5 rounded-xl text-sm font-medium hover:bg-surface-3 transition-colors">
                취소
              </button>
            </div>
          </form>
          <p v-if="tradeError" class="text-profit text-sm mt-2">{{ tradeError }}</p>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { portfolioApi, transactionsApi, analysisApi } from '@/api';
// v4.7.0: lazy-load ChartModal to keep lightweight-charts (~170KB) out of
// the initial Portfolio bundle. The chart only loads when the user clicks
// the 차트 button.
import { defineAsyncComponent } from 'vue';
const ChartModal = defineAsyncComponent(() => import('@/components/ChartModal.vue'));
import SummaryCard from '@/components/SummaryCard.vue';
import TrendBadge from '@/components/TrendBadge.vue';
import PortfolioHistoryChart from '@/components/PortfolioHistoryChart.vue';

const chartModalVisible = ref(false);
const chartModalTicker = ref('');
function openChart(ticker: string) {
  chartModalTicker.value = ticker;
  chartModalVisible.value = true;
}

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
  tradeForm.value = { type, quantity: type === 'SELL' ? holding.quantity : 0, price: holding.currentPrice || 0, fee: 0, memo: '' };
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
  } catch {}
  try {
    const { data } = await portfolioApi.getInsight();
    portfolioInsight.value = data;
  } catch {}
  loading.value = false;
}

onMounted(loadPortfolio);
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-fast) ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
