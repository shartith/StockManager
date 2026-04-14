<template>
  <div>
    <!-- 헤더 -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold text-txt-primary">대시보드</h2>
        <p class="text-sm text-txt-tertiary mt-0.5">포트폴리오 실시간 현황</p>
      </div>
      <div class="flex items-center gap-2">
        <button v-if="kisConfigured" @click="showBalance = !showBalance"
          class="flex items-center gap-2 px-4 py-2 glass-card text-accent text-sm font-medium hover:shadow-glow transition-all">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>
          </svg>
          KIS 실시간 잔고
        </button>
        <button v-if="kisConfigured && store.summary?.holdings.length === 0" @click="importBalance" :disabled="importing"
          class="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-xl text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors">
          {{ importing ? '가져오는 중...' : '계좌 잔고 가져오기' }}
        </button>
        <button @click="refresh"
          class="p-2 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-surface-2 transition-colors"
          :class="{ 'animate-spin': autoRefreshLoading }" aria-label="새로고침">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- KIS 실시간 잔고 패널 -->
    <Transition name="page-fade">
      <div v-if="showBalance" class="mb-6">
        <div class="solid-card overflow-hidden">
          <div class="flex items-center justify-between px-5 py-3 bg-accent-dim border-b border-border">
            <h3 class="text-sm font-semibold text-accent">KIS 계좌 실시간 잔고</h3>
            <button @click="loadBalance" :disabled="balanceLoading" class="text-xs text-accent hover:underline">
              {{ balanceLoading ? '조회 중...' : '새로고침' }}
            </button>
          </div>
          <div v-if="balanceError" class="p-4 text-sm text-profit">{{ balanceError }}</div>
          <div v-else-if="balanceData">
            <!-- 계좌 요약 -->
            <div class="grid grid-cols-2 md:grid-cols-5 gap-4 p-5">
              <div>
                <p class="text-xs text-txt-tertiary">국내 평가금액</p>
                <p class="font-bold text-txt-primary mt-1 tabular-nums">{{ formatCurrency(balanceData.totalEvalAmount) }}</p>
              </div>
              <div>
                <p class="text-xs text-txt-tertiary">국내 매입금액</p>
                <p class="font-bold text-txt-primary mt-1 tabular-nums">{{ formatCurrency(balanceData.totalPurchaseAmount) }}</p>
              </div>
              <div>
                <p class="text-xs text-txt-tertiary">국내 평가손익</p>
                <p class="font-bold mt-1 tabular-nums" :class="balanceData.totalProfitLoss >= 0 ? 'text-profit' : 'text-loss'">
                  {{ formatCurrency(balanceData.totalProfitLoss) }}
                </p>
              </div>
              <div>
                <p class="text-xs text-txt-tertiary">원화예수금</p>
                <p class="font-bold text-txt-primary mt-1 tabular-nums">{{ formatCurrency(balanceData.depositAmount) }}</p>
              </div>
              <div>
                <p class="text-xs text-txt-tertiary">주문가능금액</p>
                <p class="font-bold text-green-500 mt-1 tabular-nums">{{ formatCurrency(balanceData.orderableAmount || 0) }}</p>
              </div>
            </div>
            <!-- 보유 종목 -->
            <div class="overflow-x-auto">
              <table class="table-modern">
                <thead>
                  <tr>
                    <th class="text-left">종목</th>
                    <th class="text-right">수량</th>
                    <th class="text-right">평균단가</th>
                    <th class="text-right">현재가</th>
                    <th class="text-right">평가금액</th>
                    <th class="text-right">수익률</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="h in balanceData.holdings" :key="h.ticker">
                    <td class="font-medium">{{ h.ticker }} <span class="text-xs text-txt-tertiary">{{ h.name }}</span></td>
                    <td class="text-right tabular-nums">{{ h.quantity }}</td>
                    <td class="text-right tabular-nums">{{ formatCurrency(h.avgPrice) }}</td>
                    <td class="text-right tabular-nums">{{ formatCurrency(h.currentPrice) }}</td>
                    <td class="text-right tabular-nums">{{ formatCurrency(h.totalValue) }}</td>
                    <td class="text-right tabular-nums font-medium" :class="h.profitLossRate >= 0 ? 'text-profit' : 'text-loss'">
                      {{ h.profitLossRate >= 0 ? '+' : '' }}{{ h.profitLossRate.toFixed(2) }}%
                    </td>
                  </tr>
                  <tr v-if="balanceData.holdings.length === 0">
                    <td colspan="6" class="text-center py-6 text-txt-tertiary">보유 종목 없음</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- 해외 보유 종목 -->
            <div v-if="balanceData.overseasHoldings && balanceData.overseasHoldings.length > 0">
              <div class="px-5 py-3 bg-green-500/5 border-t border-b border-border">
                <h4 class="text-sm font-semibold text-green-500">해외 보유 종목</h4>
              </div>
              <div class="grid grid-cols-2 md:grid-cols-4 gap-4 p-5">
                <div>
                  <p class="text-xs text-txt-tertiary">해외 평가금액 (USD)</p>
                  <p class="font-bold text-txt-primary mt-1 tabular-nums">{{ formatUsd(balanceData.overseasTotalEvalAmount) }}</p>
                </div>
                <div>
                  <p class="text-xs text-txt-tertiary">해외 매입금액 (USD)</p>
                  <p class="font-bold text-txt-primary mt-1 tabular-nums">{{ formatUsd(balanceData.overseasTotalPurchaseAmount) }}</p>
                </div>
                <div>
                  <p class="text-xs text-txt-tertiary">해외 평가손익 (USD)</p>
                  <p class="font-bold mt-1 tabular-nums" :class="balanceData.overseasTotalProfitLoss >= 0 ? 'text-profit' : 'text-loss'">
                    {{ formatUsd(balanceData.overseasTotalProfitLoss) }}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-txt-tertiary">외화 예수금</p>
                  <p class="font-bold text-txt-primary mt-1 tabular-nums">{{ formatUsd(balanceData.overseasDepositAmount || 0) }}</p>
                </div>
              </div>
              <div class="overflow-x-auto">
                <table class="table-modern">
                  <thead>
                    <tr>
                      <th class="text-left">종목</th>
                      <th class="text-center">거래소</th>
                      <th class="text-right">수량</th>
                      <th class="text-right">평균단가</th>
                      <th class="text-right">현재가</th>
                      <th class="text-right">평가금액</th>
                      <th class="text-right">수익률</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="h in balanceData.overseasHoldings" :key="h.ticker">
                      <td class="font-medium">{{ h.ticker }} <span class="text-xs text-txt-tertiary">{{ h.name }}</span></td>
                      <td class="text-center text-xs text-txt-secondary">{{ h.market }}</td>
                      <td class="text-right tabular-nums">{{ h.quantity }}</td>
                      <td class="text-right tabular-nums">{{ formatUsd(h.avgPrice) }}</td>
                      <td class="text-right tabular-nums">{{ formatUsd(h.currentPrice) }}</td>
                      <td class="text-right tabular-nums">{{ formatUsd(h.totalValue) }}</td>
                      <td class="text-right tabular-nums font-medium" :class="h.profitLossRate >= 0 ? 'text-profit' : 'text-loss'">
                        {{ h.profitLossRate >= 0 ? '+' : '' }}{{ h.profitLossRate.toFixed(2) }}%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <!-- 가져오기 버튼 -->
            <div v-if="balanceData.holdings.length > 0 || (balanceData.overseasHoldings && balanceData.overseasHoldings.length > 0)"
              class="p-4 border-t border-border text-right">
              <button @click="importBalance" :disabled="importing"
                class="px-4 py-2 bg-primary text-white rounded-xl text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors">
                {{ importing ? '가져오는 중...' : `${balanceData.holdings.length + (balanceData.overseasHoldings?.length || 0)}개 종목을 포트폴리오로 가져오기` }}
              </button>
            </div>
          </div>
          <div v-else-if="balanceLoading" class="p-8 text-center text-txt-tertiary text-sm">잔고 조회 중...</div>
        </div>
      </div>
    </Transition>

    <!-- 동기화 결과 -->
    <Transition name="page-fade">
      <div v-if="importResult" class="mb-4 p-4 rounded-xl border text-sm space-y-2"
        :class="importResult.error ? 'bg-profit/10 border-profit/20 text-profit' : 'bg-green-500/10 border-green-500/20 text-green-500'">
        <div class="font-medium">{{ importResult.error || importResult.message }}</div>
        <template v-if="!importResult.error">
          <div v-if="syncAddedList.length" class="text-xs opacity-80">
            <span class="font-semibold">신규:</span> {{ syncAddedList.join(', ') }}
          </div>
          <div v-if="syncAdjustedList.length" class="text-xs opacity-80">
            <span class="font-semibold">조정:</span>
            <span v-for="(a, i) in syncAdjustedList" :key="a.ticker">
              {{ i > 0 ? ', ' : '' }}{{ a.ticker }} ({{ a.from }}→{{ a.to }})
            </span>
          </div>
          <div v-if="syncRemovedList.length" class="text-xs opacity-80">
            <span class="font-semibold">매도:</span>
            <span v-for="(r, i) in syncRemovedList" :key="r.ticker">
              {{ i > 0 ? ', ' : '' }}{{ r.ticker }} ({{ r.quantity }}주)
            </span>
          </div>
        </template>
      </div>
    </Transition>

    <!-- 시장 동향 티커 스트립 -->
    <div v-if="marketCtx" class="ticker-strip mb-6">
      <div v-for="item in marketItems" :key="item.label"
        class="glass-card px-4 py-3 min-w-[140px]">
        <p class="text-[10px] text-txt-tertiary font-medium uppercase tracking-wider">{{ item.label }}</p>
        <div class="flex items-baseline gap-2 mt-1">
          <AnimatedNumber :value="item.price" :format="item.isUsd ? 'number' : 'number'" :decimals="item.decimals" class="text-sm font-bold text-txt-primary" />
          <TrendBadge v-if="item.change !== undefined" :value="item.change" :decimals="1" />
        </div>
      </div>
    </div>

    <!-- 시스템 상태 바 -->
    <div class="flex flex-wrap gap-3 mb-6">
      <div class="glass-card px-4 py-2.5 flex items-center gap-2">
        <span class="status-dot" :class="systemStatus.schedulerActive ? 'connected' : 'disconnected'" />
        <span class="text-xs text-txt-secondary">
          스케줄러 {{ systemStatus.schedulerActive ? `활성 (${systemStatus.taskCount}개)` : '비활성' }}
        </span>
      </div>
      <div class="glass-card px-4 py-2.5 flex items-center gap-2">
        <span class="status-dot" :class="systemStatus.ollamaConnected ? 'connected' : 'disconnected'" />
        <span class="text-xs text-txt-secondary">
          Ollama {{ systemStatus.ollamaConnected ? '연결됨' : '미연결' }}
        </span>
      </div>
      <div class="glass-card px-4 py-2.5 flex items-center gap-3">
        <span class="text-xs text-txt-tertiary">오늘의 신호</span>
        <span class="text-xs font-bold text-profit">매수 {{ systemStatus.todayBuy }}</span>
        <span class="text-xs font-bold text-loss">매도 {{ systemStatus.todaySell }}</span>
        <span class="text-xs font-bold text-txt-tertiary">관망 {{ systemStatus.todayHold }}</span>
      </div>
    </div>

    <!-- 시스템 이벤트 -->
    <Transition name="page-fade">
      <div v-if="eventCounts && eventCounts.unresolved > 0" class="mb-6">
        <div class="solid-card overflow-hidden"
          :class="eventCounts.critical > 0 ? '!border-profit/30' : eventCounts.error > 0 ? '!border-amber-500/30' : ''">
          <div class="flex items-center justify-between px-4 py-3"
            :class="eventCounts.critical > 0 ? 'bg-profit/5' : eventCounts.error > 0 ? 'bg-amber-500/5' : 'bg-surface-2'">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold" :class="eventCounts.critical > 0 ? 'text-profit' : 'text-amber-500'">
                시스템 이벤트 ({{ eventCounts.unresolved }}건 미해결)
              </span>
              <span v-if="eventCounts.critical > 0" class="text-[10px] px-1.5 py-0.5 bg-profit/10 text-profit rounded font-medium">CRITICAL {{ eventCounts.critical }}</span>
              <span v-if="eventCounts.error > 0" class="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-500 rounded font-medium">ERROR {{ eventCounts.error }}</span>
            </div>
            <div class="flex items-center gap-3">
              <button @click="deleteAllEventsFn"
                :disabled="(eventCounts?.critical ?? 0) > 0"
                :title="(eventCounts?.critical ?? 0) > 0 ? '미해결 CRITICAL 이벤트가 있습니다 — 먼저 확인 후 삭제하세요' : '모든 이벤트 삭제'"
                class="text-xs text-profit hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-profit rounded disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline">
                모두 삭제
              </button>
              <button @click="showEvents = !showEvents" class="text-xs text-accent hover:underline">
                {{ showEvents ? '접기' : '펼치기' }}
              </button>
            </div>
          </div>
          <div v-if="showEvents" class="max-h-64 overflow-y-auto">
            <div v-for="e in unresolvedEvents" :key="e.id" class="px-4 py-3 border-t border-border-subtle text-sm">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    :class="{
                      'bg-profit/10 text-profit': e.severity === 'CRITICAL',
                      'bg-amber-500/10 text-amber-500': e.severity === 'ERROR',
                      'bg-yellow-500/10 text-yellow-500': e.severity === 'WARN',
                      'bg-surface-2 text-txt-tertiary': e.severity === 'INFO',
                    }">{{ e.severity }}</span>
                  <span class="font-medium text-txt-primary">{{ e.title }}</span>
                  <span v-if="e.ticker" class="text-xs text-txt-tertiary">({{ e.ticker }})</span>
                </div>
                <span class="text-xs text-txt-tertiary">{{ formatKST(e.created_at) }}</span>
              </div>
              <p v-if="e.detail" class="text-xs text-txt-secondary mt-1 whitespace-pre-line">{{ e.detail.slice(0, 300) }}</p>
              <button @click="resolveEventFn(e.id)" class="text-xs text-green-500 hover:underline mt-1">해결 처리</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <div v-if="store.loading" class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
    </div>
    <div v-else-if="store.error" class="solid-card p-6 text-center text-profit">{{ store.error }}</div>

    <template v-else-if="store.summary">
      <!-- Bento 그리드: 요약 카드 -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          label="총 투자금액"
          :value="formatCurrency(store.summary.totalInvested)"
          :numeric-value="store.summary.totalInvested"
          format="currency"
        />
        <SummaryCard
          label="현재 평가금액"
          :value="formatCurrency(store.summary.totalCurrentValue)"
          :numeric-value="store.summary.totalCurrentValue"
          format="currency"
        />
        <SummaryCard
          label="총 수익/손실"
          :value="formatCurrency(store.summary.totalProfitLoss)"
          :numeric-value="store.summary.totalProfitLoss"
          format="currency"
          :show-sign="true"
          :change="store.summary.totalProfitLossPercent"
          :color="store.summary.totalProfitLoss >= 0 ? 'text-profit' : 'text-loss'"
        />
        <SummaryCard
          label="총 배당금"
          :value="formatCurrency(store.summary.totalDividends)"
          :numeric-value="store.summary.totalDividends"
          format="currency"
          color="text-accent"
        />
      </div>

      <!-- 차트 영역 -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div class="glass-card p-5">
          <h3 class="text-sm font-semibold text-txt-secondary mb-4">
            자산 배분
            <span class="text-xs font-normal text-txt-tertiary ml-1">
              {{ store.summary.allocationBy === 'sector' ? '섹터별' : '종목별' }}
            </span>
          </h3>
          <AllocationChart v-if="store.summary.allocation.length > 0" :data="store.summary.allocation" />
          <p v-else class="text-txt-tertiary text-sm py-8 text-center">데이터가 없습니다</p>
        </div>
        <div class="glass-card p-5">
          <h3 class="text-sm font-semibold text-txt-secondary mb-4">보유 종목 수익률</h3>
          <StockChart v-if="store.summary.holdings.length > 0" :holdings="store.summary.holdings" />
          <p v-else class="text-txt-tertiary text-sm py-8 text-center">데이터가 없습니다</p>
        </div>
      </div>

      <!-- 포트폴리오 히스토리 -->
      <div class="solid-card mb-8 overflow-hidden">
        <div class="p-5 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-secondary">포트폴리오 히스토리 (누적 순투자 / 수수료)</h3>
          <p class="text-xs text-txt-tertiary mt-1">transactions 테이블 기반, 날짜별 누적 매수/매도/수수료</p>
        </div>
        <div class="p-5 h-72">
          <PortfolioHistoryChart />
        </div>
      </div>

      <!-- 체결률 지표 (v4.11.0) -->
      <div v-if="fillRate" class="solid-card mb-8 overflow-hidden">
        <div class="p-5 border-b border-border flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold text-txt-secondary">⚡ 체결률 (최근 {{ fillRate.days }}일)</h3>
            <p class="text-xs text-txt-tertiary mt-1">BUY 신호 대비 실제/가상 체결 비율 — 시스템 효율성 지표</p>
          </div>
        </div>
        <div class="p-5 grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <p class="text-xs text-txt-secondary mb-1">BUY 신호</p>
            <p class="text-2xl font-bold text-txt-primary">{{ fillRate.signals }}</p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">실매수</p>
            <p class="text-2xl font-bold text-accent">{{ fillRate.realFills }}</p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">🧪 가상매수</p>
            <p class="text-2xl font-bold text-purple-500">{{ fillRate.paperFills }}</p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">차단(BLOCKED)</p>
            <p class="text-2xl font-bold text-txt-tertiary">{{ fillRate.blocked }}</p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">체결률 (실+가상)</p>
            <p class="text-2xl font-bold" :class="fillRate.combinedFillRate >= 50 ? 'text-profit' : fillRate.combinedFillRate >= 20 ? 'text-amber-500' : 'text-loss'">
              {{ fillRate.combinedFillRate }}%
            </p>
          </div>
        </div>
      </div>

      <!-- 가상매매(Paper Trading) 요약 -->
      <div v-if="paperSummary" class="solid-card mb-8 overflow-hidden border-l-4 border-purple-500">
        <div class="p-5 border-b border-border flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold text-txt-secondary">🧪 가상매매 현황 <span class="text-xs font-normal text-purple-500 ml-1">학습 데이터</span></h3>
            <p class="text-xs text-txt-tertiary mt-1">실매매 안 된 추천 종목을 자동 가상매수하여 모델 정확도 평가에 활용</p>
          </div>
        </div>
        <div class="p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p class="text-xs text-txt-secondary mb-1">오픈 포지션</p>
            <p class="text-2xl font-bold text-txt-primary">{{ paperSummary.openPositions }}<span class="text-sm text-txt-tertiary ml-1">종목</span></p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">실현 손익</p>
            <p class="text-2xl font-bold tabular-nums" :class="paperSummary.totalRealizedPnL >= 0 ? 'text-profit' : 'text-loss'">
              {{ paperSummary.totalRealizedPnL >= 0 ? '+' : '' }}{{ Math.round(paperSummary.totalRealizedPnL).toLocaleString() }}<span class="text-sm text-txt-tertiary ml-1">원</span>
            </p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">평균 수익률</p>
            <p class="text-2xl font-bold" :class="paperSummary.totalRealizedPnLPercent >= 0 ? 'text-profit' : 'text-loss'">
              {{ paperSummary.totalRealizedPnLPercent >= 0 ? '+' : '' }}{{ paperSummary.totalRealizedPnLPercent.toFixed(1) }}%
            </p>
          </div>
          <div>
            <p class="text-xs text-txt-secondary mb-1">승률 ({{ paperSummary.closedTrades }}건)</p>
            <p class="text-2xl font-bold" :class="paperSummary.winRate >= 50 ? 'text-profit' : 'text-loss'">
              {{ paperSummary.winRate }}%
            </p>
          </div>
        </div>
      </div>

      <!-- 보유 종목 테이블 -->
      <div class="solid-card overflow-hidden">
        <div class="p-5 border-b border-border">
          <h3 class="text-sm font-semibold text-txt-secondary">보유 종목 현황</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="table-modern">
            <thead>
              <tr>
                <th class="text-left">종목</th>
                <th class="text-right">수량</th>
                <th class="text-right">평균단가</th>
                <th class="text-right">현재가</th>
                <th class="text-right">평가금액</th>
                <th class="text-right">수익/손실</th>
                <th class="text-right">수익률</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in store.summary.holdings" :key="h.stockId">
                <td>
                  <div class="font-medium text-txt-primary">{{ h.ticker }}</div>
                  <div class="text-xs text-txt-tertiary">{{ h.name }}</div>
                </td>
                <td class="text-right tabular-nums">{{ h.quantity }}</td>
                <td class="text-right tabular-nums text-txt-secondary">{{ formatByMarket(h.avgPrice, h.market) }}</td>
                <td class="text-right tabular-nums font-medium">{{ h.currentPrice ? formatByMarket(h.currentPrice, h.market) : '-' }}</td>
                <td class="text-right tabular-nums">{{ h.currentValue ? formatByMarket(h.currentValue, h.market) : formatByMarket(h.totalCost, h.market) }}</td>
                <td class="text-right tabular-nums font-medium" :class="(h.profitLoss ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                  {{ h.profitLoss !== undefined ? formatByMarket(h.profitLoss, h.market) : '-' }}
                </td>
                <td class="text-right">
                  <TrendBadge v-if="h.profitLossPercent !== undefined" :value="h.profitLossPercent" />
                  <span v-else class="text-txt-tertiary">-</span>
                </td>
              </tr>
              <tr v-if="store.summary.holdings.length === 0">
                <td colspan="7" class="text-center py-12 text-txt-tertiary">
                  <p class="mb-2">보유 종목이 없습니다.</p>
                  <p v-if="kisConfigured" class="text-xs">
                    상단 <strong>계좌 잔고 가져오기</strong> 버튼으로 KIS 계좌에서 바로 불러올 수 있습니다.
                  </p>
                  <p v-else class="text-xs">
                    <router-link to="/settings" class="text-accent underline">설정</router-link>에서 KIS API를 연결하거나,
                    <router-link to="/transactions" class="text-accent underline">거래 내역</router-link>에서 직접 추가하세요.
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
import { ref, computed, onMounted, inject, type Ref } from 'vue';
import { usePortfolioStore } from '@/stores/portfolio';
import { chartApi, schedulerApi, analysisApi, systemEventsApi, paperTradingApi } from '@/api';
import { useAutoRefresh } from '@/composables/useAutoRefresh';

// v4.7.3: pull the toast singleton provided by App.vue so destructive
// actions can report failures to the user.
interface ToastShowOpts { type?: string; title?: string; message: string; duration?: number; }
interface ToastInstance { show: (opts: ToastShowOpts) => void; }
const toastRef = inject<Ref<ToastInstance | null> | null>('toast', null);
import SummaryCard from '@/components/SummaryCard.vue';
import AllocationChart from '@/components/AllocationChart.vue';
import StockChart from '@/components/StockChart.vue';
import PortfolioHistoryChart from '@/components/PortfolioHistoryChart.vue';
import AnimatedNumber from '@/components/AnimatedNumber.vue';
import TrendBadge from '@/components/TrendBadge.vue';

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

// Auto-refresh with WebSocket fallback
const { loading: autoRefreshLoading, refresh } = useAutoRefresh(
  async () => {
    await store.fetchSummary();
    await loadMarketContext();
    await loadSystemEvents();
  },
  { wsChannel: 'portfolio', immediate: false }
);

// Market items for ticker strip
// 동기화 결과 파싱 (krx + overseas 합산)
interface SyncAdjusted { ticker: string; from: number; to: number; delta: number; }
interface SyncRemoved { ticker: string; quantity: number; }

const syncAddedList = computed<string[]>(() => {
  const r = importResult.value;
  if (!r || r.error) return [];
  return [...(r.krx?.added ?? []), ...(r.overseas?.added ?? [])];
});

const syncAdjustedList = computed<SyncAdjusted[]>(() => {
  const r = importResult.value;
  if (!r || r.error) return [];
  return [...(r.krx?.adjusted ?? []), ...(r.overseas?.adjusted ?? [])];
});

const syncRemovedList = computed<SyncRemoved[]>(() => {
  const r = importResult.value;
  if (!r || r.error) return [];
  return [...(r.krx?.removed ?? []), ...(r.overseas?.removed ?? [])];
});

const marketItems = computed(() => {
  if (!marketCtx.value) return [];
  const items: Array<{ label: string; price: number; change?: number; decimals: number; isUsd?: boolean }> = [];
  const mc = marketCtx.value;
  if (mc.kospi) items.push({ label: 'KOSPI', price: mc.kospi.price, change: mc.kospi.changePercent, decimals: 0 });
  if (mc.kosdaq) items.push({ label: 'KOSDAQ', price: mc.kosdaq.price, change: mc.kosdaq.changePercent, decimals: 0 });
  if (mc.sp500) items.push({ label: 'S&P 500', price: mc.sp500.price, change: mc.sp500.changePercent, decimals: 0 });
  if (mc.vix) items.push({ label: 'VIX', price: mc.vix.price, change: mc.vix.changePercent, decimals: 1 });
  if (mc.usdKrw) items.push({ label: 'USD/KRW', price: mc.usdKrw.price, change: mc.usdKrw.changePercent, decimals: 0 });
  if (mc.dow) items.push({ label: 'DOW', price: mc.dow.price, change: mc.dow.changePercent, decimals: 0 });
  return items;
});

function formatKST(dt: string): string {
  if (!dt) return '';
  const d = new Date(dt.includes('Z') ? dt : dt + 'Z');
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

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
    if (data.recentLogs) {
      const today = new Date().toISOString().slice(0, 10);
      const todayLogs = data.recentLogs.filter((l: any) => l.timestamp?.startsWith(today));
      systemStatus.value.todayBuy = todayLogs.filter((l: any) => l.message?.includes('BUY')).length;
      systemStatus.value.todaySell = todayLogs.filter((l: any) => l.message?.includes('SELL')).length;
      systemStatus.value.todayHold = todayLogs.filter((l: any) => l.message?.includes('HOLD')).length;
    }
  } catch {}

  try {
    const { data } = await analysisApi.getOllamaStatus();
    systemStatus.value.ollamaConnected = data.connected;
  } catch {}
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

async function deleteAllEventsFn() {
  // v4.7.3: confirm dialog count must match what the server actually deletes.
  // systemEventsApi.deleteAll() (no args) deletes ALL events, not just
  // unresolved ones, so use eventCounts.total instead of unresolved.
  const total = eventCounts.value?.total ?? eventCounts.value?.unresolved ?? 0;
  if (total === 0) return;
  if (!confirm(`시스템 이벤트 ${total}건(해결된 이벤트 포함)을 모두 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await systemEventsApi.deleteAll();
    eventCounts.value = null;
    unresolvedEvents.value = [];
    await loadSystemEvents();
  } catch (err) {
    // v4.7.3: surface destructive-action failures
    toastRef?.value?.show({
      type: 'error',
      title: '이벤트 삭제 실패',
      message: err instanceof Error ? err.message : '서버에 요청을 전달하지 못했습니다.',
    });
  }
}

async function loadMarketContext() {
  try {
    const { data } = await chartApi.getMarketContext();
    marketCtx.value = data;
  } catch {}
}

interface PaperSummary {
  openPositions: number;
  totalRealizedPnL: number;
  totalRealizedPnLPercent: number;
  closedTrades: number;
  winRate: number;
}
const paperSummary = ref<PaperSummary | null>(null);

async function loadPaperSummary() {
  try {
    const { data } = await paperTradingApi.getSummary();
    paperSummary.value = data;
  } catch {
    paperSummary.value = null;
  }
}

// v4.11.0: 체결률 지표
interface FillRate {
  days: number; signals: number; realFills: number; paperFills: number; blocked: number;
  realFillRate: number; combinedFillRate: number;
}
const fillRate = ref<FillRate | null>(null);

async function loadFillRate() {
  try {
    const { data } = await schedulerApi.getFillRate(7);
    fillRate.value = data;
  } catch {
    fillRate.value = null;
  }
}

onMounted(async () => {
  await checkKisConfig();
  store.fetchSummary();
  loadSystemStatus();
  loadMarketContext();
  loadSystemEvents();
  loadPaperSummary();
  loadFillRate();
});
</script>
