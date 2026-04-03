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
          <!-- 계좌 요약 (국내) -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 border-b border-slate-100">
            <div>
              <p class="text-xs text-slate-500">국내 평가금액</p>
              <p class="font-bold text-slate-800">{{ formatCurrency(balanceData.totalEvalAmount) }}</p>
            </div>
            <div>
              <p class="text-xs text-slate-500">국내 매입금액</p>
              <p class="font-bold text-slate-800">{{ formatCurrency(balanceData.totalPurchaseAmount) }}</p>
            </div>
            <div>
              <p class="text-xs text-slate-500">국내 평가손익</p>
              <p class="font-bold" :class="balanceData.totalProfitLoss >= 0 ? 'text-red-600' : 'text-blue-600'">
                {{ formatCurrency(balanceData.totalProfitLoss) }}
              </p>
            </div>
            <div>
              <p class="text-xs text-slate-500">원화예수금</p>
              <p class="font-bold text-slate-800">{{ formatCurrency(balanceData.depositAmount) }}</p>
            </div>
            <div>
              <p class="text-xs text-slate-500">주문가능금액</p>
              <p class="font-bold text-green-700">{{ formatCurrency(balanceData.orderableAmount || 0) }}</p>
              <p v-if="balanceData.orderableAmount && balanceData.orderableAmount !== balanceData.depositAmount" class="text-xs text-slate-400">담보 포함</p>
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
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 border-b border-slate-100">
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
              <div>
                <p class="text-xs text-slate-500">외화 예수금</p>
                <p class="font-bold text-slate-800" v-if="balanceData.overseasDepositAmount > 0">
                  {{ formatUsd(balanceData.overseasDepositAmount) }}
                </p>
                <p class="font-bold text-slate-800" v-else-if="(balanceData.depositAmount || 0) - (balanceData.withdrawableAmount || 0) > 0">
                  {{ formatCurrency((balanceData.depositAmount || 0) - (balanceData.withdrawableAmount || 0)) }}
                  <span class="text-xs text-slate-400 font-normal ml-1">KRW 환산</span>
                </p>
                <p class="font-bold text-slate-800" v-else>{{ formatUsd(0) }}</p>
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

    <!-- 시스템 이벤트 (미해결) -->
    <div v-if="eventCounts && eventCounts.unresolved > 0" class="mb-6">
      <div class="bg-white rounded-xl border shadow-sm overflow-hidden"
        :class="eventCounts.critical > 0 ? 'border-red-300' : eventCounts.error > 0 ? 'border-amber-300' : 'border-slate-200'">
        <div class="flex items-center justify-between px-4 py-3"
          :class="eventCounts.critical > 0 ? 'bg-red-50' : eventCounts.error > 0 ? 'bg-amber-50' : 'bg-slate-50'">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold"
              :class="eventCounts.critical > 0 ? 'text-red-800' : 'text-amber-800'">
              시스템 이벤트 ({{ eventCounts.unresolved }}건 미해결)
            </span>
            <span v-if="eventCounts.critical > 0" class="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded">CRITICAL {{ eventCounts.critical }}</span>
            <span v-if="eventCounts.error > 0" class="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">ERROR {{ eventCounts.error }}</span>
          </div>
          <button @click="showEvents = !showEvents" class="text-xs text-blue-600 hover:underline">
            {{ showEvents ? '접기' : '펼치기' }}
          </button>
        </div>
        <div v-if="showEvents" class="max-h-64 overflow-y-auto">
          <div v-for="e in unresolvedEvents" :key="e.id" class="px-4 py-3 border-t border-slate-100 text-sm">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xs px-1.5 py-0.5 rounded font-medium"
                  :class="{
                    'bg-red-100 text-red-700': e.severity === 'CRITICAL',
                    'bg-amber-100 text-amber-700': e.severity === 'ERROR',
                    'bg-yellow-100 text-yellow-700': e.severity === 'WARN',
                    'bg-slate-100 text-slate-600': e.severity === 'INFO',
                  }">{{ e.severity }}</span>
                <span class="font-medium text-slate-700">{{ e.title }}</span>
                <span v-if="e.ticker" class="text-xs text-slate-400">({{ e.ticker }})</span>
              </div>
              <span class="text-xs text-slate-400">{{ e.created_at?.slice(5, 16) }}</span>
            </div>
            <p v-if="e.detail" class="text-xs text-slate-500 mt-1 whitespace-pre-line">{{ e.detail.slice(0, 300) }}</p>
            <button @click="resolveEventFn(e.id)" class="text-xs text-green-600 hover:underline mt-1">해결 처리</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 시장 동향 -->
    <div v-if="marketCtx" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
      <div v-if="marketCtx.kospi" class="bg-white rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-400">KOSPI</p>
        <p class="text-sm font-bold" :class="marketCtx.kospi.changePercent >= 0 ? 'text-red-600' : 'text-blue-600'">
          {{ marketCtx.kospi.price.toLocaleString() }}
          <span class="text-xs font-normal">({{ marketCtx.kospi.changePercent >= 0 ? '+' : '' }}{{ marketCtx.kospi.changePercent }}%)</span>
        </p>
      </div>
      <div v-if="marketCtx.kosdaq" class="bg-white rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-400">KOSDAQ</p>
        <p class="text-sm font-bold" :class="marketCtx.kosdaq.changePercent >= 0 ? 'text-red-600' : 'text-blue-600'">
          {{ marketCtx.kosdaq.price.toLocaleString() }}
          <span class="text-xs font-normal">({{ marketCtx.kosdaq.changePercent >= 0 ? '+' : '' }}{{ marketCtx.kosdaq.changePercent }}%)</span>
        </p>
      </div>
      <div v-if="marketCtx.sp500" class="bg-white rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-400">S&P 500</p>
        <p class="text-sm font-bold" :class="marketCtx.sp500.changePercent >= 0 ? 'text-red-600' : 'text-blue-600'">
          {{ marketCtx.sp500.price.toLocaleString() }}
          <span class="text-xs font-normal">({{ marketCtx.sp500.changePercent >= 0 ? '+' : '' }}{{ marketCtx.sp500.changePercent }}%)</span>
        </p>
      </div>
      <div v-if="marketCtx.vix" class="bg-white rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-400">VIX (공포지수)</p>
        <p class="text-sm font-bold" :class="marketCtx.vix.price > 25 ? 'text-red-600' : marketCtx.vix.price > 20 ? 'text-amber-600' : 'text-green-600'">
          {{ marketCtx.vix.price.toFixed(1) }}
          <span class="text-xs font-normal">{{ marketCtx.vix.price > 30 ? '극도공포' : marketCtx.vix.price > 25 ? '공포' : marketCtx.vix.price > 20 ? '주의' : '안정' }}</span>
        </p>
      </div>
      <div v-if="marketCtx.usdKrw" class="bg-white rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-400">USD/KRW</p>
        <p class="text-sm font-bold" :class="marketCtx.usdKrw.changePercent >= 0 ? 'text-red-600' : 'text-blue-600'">
          {{ marketCtx.usdKrw.price.toLocaleString() }}
          <span class="text-xs font-normal">({{ marketCtx.usdKrw.changePercent >= 0 ? '+' : '' }}{{ marketCtx.usdKrw.changePercent }}%)</span>
        </p>
      </div>
      <div v-if="marketCtx.dow" class="bg-white rounded-lg border border-slate-200 p-3">
        <p class="text-xs text-slate-400">다우존스</p>
        <p class="text-sm font-bold" :class="marketCtx.dow.changePercent >= 0 ? 'text-red-600' : 'text-blue-600'">
          {{ marketCtx.dow.price.toLocaleString() }}
          <span class="text-xs font-normal">({{ marketCtx.dow.changePercent >= 0 ? '+' : '' }}{{ marketCtx.dow.changePercent }}%)</span>
        </p>
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
                <td class="text-right px-4 py-3">{{ formatByMarket(h.avgPrice, h.market) }}</td>
                <td class="text-right px-4 py-3">{{ h.currentPrice ? formatByMarket(h.currentPrice, h.market) : '-' }}</td>
                <td class="text-right px-4 py-3">{{ h.currentValue ? formatByMarket(h.currentValue, h.market) : formatByMarket(h.totalCost, h.market) }}</td>
                <td class="text-right px-4 py-3" :class="(h.profitLoss ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                  {{ h.profitLoss !== undefined ? formatByMarket(h.profitLoss, h.market) : '-' }}
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
import { chartApi, schedulerApi, analysisApi, systemEventsApi } from '@/api';
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
const marketCtx = ref<any>(null);
const eventCounts = ref<any>(null);
const unresolvedEvents = ref<any[]>([]);
const showEvents = ref(false);

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

function isOverseasMarket(market: string): boolean {
  return ['NASDAQ', 'NYSE', 'AMEX', 'NASD'].includes(market);
}

function formatByMarket(value: number, market: string): string {
  return isOverseasMarket(market) ? formatUsd(value) : formatCurrency(value);
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

// WebSocket 실시간 시세
const livePrices = ref<Record<string, number>>({});
const wsConnected = ref(false);

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  ws.onopen = () => { wsConnected.value = true; };
  ws.onclose = () => {
    wsConnected.value = false;
    setTimeout(connectWebSocket, 5000); // 5초 후 재연결
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'prices') {
        livePrices.value = { ...livePrices.value, ...msg.data };
      }
    } catch {}
  };
}

async function loadSystemEvents() {
  try {
    const { data: counts } = await systemEventsApi.getCounts();
    eventCounts.value = counts;
    if (counts.unresolved > 0) {
      const { data } = await systemEventsApi.getAll({ unresolved: true, limit: 20 });
      unresolvedEvents.value = data;
    }
  } catch {}
}

async function resolveEventFn(id: number) {
  try {
    await systemEventsApi.resolve(id, '대시보드에서 수동 해결');
    await loadSystemEvents();
  } catch {}
}

async function loadMarketContext() {
  try {
    const { data } = await chartApi.getMarketContext();
    marketCtx.value = data;
  } catch {}
}

onMounted(async () => {
  await checkKisConfig();
  store.fetchSummary();
  loadSystemStatus();
  loadMarketContext();
  loadSystemEvents();
  connectWebSocket();
});
</script>
