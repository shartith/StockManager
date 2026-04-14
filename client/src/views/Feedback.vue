<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold text-txt-primary">성과 분석</h2>
      <div class="flex gap-2">
        <select v-model="analysisDays" @change="loadAll"
          class="px-3 py-2 border border-border rounded-lg text-sm">
          <option :value="30">최근 30일</option>
          <option :value="60">최근 60일</option>
          <option :value="90">최근 90일</option>
          <option :value="180">최근 180일</option>
        </select>
      </div>
    </div>

    <!-- 탭 -->
    <div class="flex gap-1 mb-6 bg-surface-3 rounded-lg p-1 w-fit">
      <button v-for="tab in tabs" :key="tab.value" @click="activeTab = tab.value"
        class="px-4 py-2 rounded text-sm font-medium transition-colors"
        :class="activeTab === tab.value ? 'bg-surface-1 text-txt-primary shadow-sm' : 'text-txt-secondary hover:text-txt-primary'">
        {{ tab.label }}
      </button>
    </div>

    <!-- 성과 요약 -->
    <div v-if="activeTab === 'performance'">
      <div v-if="loading" class="text-txt-tertiary text-sm py-8 text-center">로딩 중...</div>
      <div v-else>
        <!-- 핵심 지표 카드 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">총 신호</p>
            <p class="text-2xl font-bold text-txt-primary">{{ perf.totalSignals || 0 }}</p>
            <p class="text-xs text-txt-tertiary mt-1">BUY {{ perf.buyCount || 0 }} / SELL {{ perf.sellCount || 0 }}</p>
          </div>
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">BUY 승률 (7일)</p>
            <p class="text-2xl font-bold" :class="(perf.buyWinRate7d || 0) >= 50 ? 'text-profit' : 'text-loss'">
              {{ perf.buyWinRate7d !== null ? perf.buyWinRate7d + '%' : '-' }}
            </p>
          </div>
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">평균 수익률 (7일)</p>
            <p class="text-2xl font-bold" :class="(perf.avgBuyReturn7d || 0) >= 0 ? 'text-profit' : 'text-loss'">
              {{ perf.avgBuyReturn7d !== null ? (perf.avgBuyReturn7d >= 0 ? '+' : '') + perf.avgBuyReturn7d + '%' : '-' }}
            </p>
          </div>
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">목표가 도달률</p>
            <p class="text-2xl font-bold text-txt-primary">{{ perf.targetHitRate !== null ? perf.targetHitRate + '%' : '-' }}</p>
          </div>
        </div>

        <!-- 기간별 수익률 -->
        <div class="bg-surface-1 rounded-xl border border-border p-5 mb-6">
          <h3 class="font-semibold text-txt-primary mb-4">기간별 평균 수익률</h3>
          <div class="grid grid-cols-3 gap-6">
            <div class="text-center">
              <p class="text-xs text-txt-secondary mb-2">7일</p>
              <div class="text-3xl font-bold" :class="(perf.avgBuyReturn7d || 0) >= 0 ? 'text-profit' : 'text-loss'">
                {{ perf.avgBuyReturn7d !== null ? (perf.avgBuyReturn7d >= 0 ? '+' : '') + perf.avgBuyReturn7d + '%' : '-' }}
              </div>
            </div>
            <div class="text-center">
              <p class="text-xs text-txt-secondary mb-2">14일</p>
              <div class="text-3xl font-bold" :class="(perf.avgBuyReturn14d || 0) >= 0 ? 'text-profit' : 'text-loss'">
                {{ perf.avgBuyReturn14d !== null ? (perf.avgBuyReturn14d >= 0 ? '+' : '') + perf.avgBuyReturn14d + '%' : '-' }}
              </div>
            </div>
            <div class="text-center">
              <p class="text-xs text-txt-secondary mb-2">30일</p>
              <div class="text-3xl font-bold" :class="(perf.avgBuyReturn30d || 0) >= 0 ? 'text-profit' : 'text-loss'">
                {{ perf.avgBuyReturn30d !== null ? (perf.avgBuyReturn30d >= 0 ? '+' : '') + perf.avgBuyReturn30d + '%' : '-' }}
              </div>
            </div>
          </div>
        </div>

        <!-- 손절가 도달률 -->
        <div class="bg-surface-1 rounded-xl border border-border p-5">
          <h3 class="font-semibold text-txt-primary mb-3">리스크 지표</h3>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <p class="text-sm text-txt-secondary">손절가 도달률</p>
              <p class="text-xl font-bold text-loss">{{ perf.stopLossHitRate !== null ? perf.stopLossHitRate + '%' : '-' }}</p>
            </div>
            <div>
              <p class="text-sm text-txt-secondary">목표가 도달률</p>
              <p class="text-xl font-bold text-profit">{{ perf.targetHitRate !== null ? perf.targetHitRate + '%' : '-' }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 정확도 분석 -->
    <div v-if="activeTab === 'accuracy'">
      <div v-if="loading" class="text-txt-tertiary text-sm py-8 text-center">로딩 중...</div>
      <div v-else-if="accuracy.totalEvaluated === 0" class="text-center py-16 text-txt-tertiary">
        <p class="text-4xl mb-3">📊</p>
        <p>평가된 신호가 없습니다</p>
        <p class="text-xs mt-1">신호 발생 후 7일이 지나면 자동 평가됩니다</p>
      </div>
      <div v-else>
        <!-- 전체 요약 -->
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">평가 완료</p>
            <p class="text-2xl font-bold text-txt-primary">{{ accuracy.totalEvaluated }}건</p>
          </div>
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">전체 승률</p>
            <p class="text-2xl font-bold" :class="(accuracy.overallWinRate || 0) >= 50 ? 'text-profit' : 'text-loss'">
              {{ accuracy.overallWinRate !== null ? accuracy.overallWinRate + '%' : '-' }}
            </p>
          </div>
          <div class="bg-surface-1 rounded-xl border border-border p-4">
            <p class="text-xs text-txt-secondary mb-1">7일 평균 수익률</p>
            <p class="text-2xl font-bold" :class="(accuracy.avgReturn7d || 0) >= 0 ? 'text-profit' : 'text-loss'">
              {{ accuracy.avgReturn7d !== null ? (accuracy.avgReturn7d >= 0 ? '+' : '') + accuracy.avgReturn7d + '%' : '-' }}
            </p>
          </div>
        </div>

        <!-- 신뢰도별 승률 -->
        <div v-if="accuracy.byConfidence.length > 0" class="bg-surface-1 rounded-xl border border-border p-5 mb-6">
          <h3 class="font-semibold text-txt-primary mb-4">신뢰도 구간별 승률</h3>
          <div class="space-y-3">
            <div v-for="b in accuracy.byConfidence" :key="b.bracket" class="flex items-center gap-3">
              <span class="text-sm font-mono text-txt-secondary w-20">{{ b.bracket }}%</span>
              <div class="flex-1 bg-surface-3 rounded-full h-6 overflow-hidden">
                <div class="h-full rounded-full flex items-center px-2 text-xs text-white font-medium transition-all"
                  :class="b.winRate >= 50 ? 'bg-red-500' : 'bg-blue-500'"
                  :style="{ width: Math.max(b.winRate, 8) + '%' }">
                  {{ b.winRate }}%
                </div>
              </div>
              <span class="text-xs text-txt-tertiary w-16 text-right">{{ b.count }}건 ({{ b.avgReturn >= 0 ? '+' : '' }}{{ b.avgReturn }}%)</span>
            </div>
          </div>
        </div>

        <!-- 시장별 -->
        <div v-if="accuracy.byMarket.length > 0" class="bg-surface-1 rounded-xl border border-border p-5 mb-6">
          <h3 class="font-semibold text-txt-primary mb-4">시장별 승률</h3>
          <div class="grid grid-cols-3 gap-4">
            <div v-for="m in accuracy.byMarket" :key="m.market" class="text-center p-3 rounded-lg bg-surface-2">
              <p class="text-sm font-medium text-txt-primary">{{ m.market }}</p>
              <p class="text-xl font-bold mt-1" :class="m.winRate >= 50 ? 'text-profit' : 'text-loss'">{{ m.winRate }}%</p>
              <p class="text-xs text-txt-tertiary">{{ m.count }}건 / 평균 {{ m.avgReturn >= 0 ? '+' : '' }}{{ m.avgReturn }}%</p>
            </div>
          </div>
        </div>

        <!-- 핵심 요인 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div v-if="accuracy.bestFactors.length > 0" class="bg-surface-1 rounded-xl border border-border p-5">
            <h3 class="font-semibold text-red-700 mb-3">신뢰할 수 있는 요인</h3>
            <div v-for="f in accuracy.bestFactors" :key="f.factor" class="flex items-center justify-between py-2 border-b border-border-subtle last:border-0">
              <span class="text-sm text-txt-primary">{{ f.factor }}</span>
              <span class="text-sm font-bold text-profit">{{ f.winRate }}% <span class="text-xs text-txt-tertiary font-normal">({{ f.count }}건)</span></span>
            </div>
          </div>
          <div v-if="accuracy.worstFactors.length > 0" class="bg-surface-1 rounded-xl border border-border p-5">
            <h3 class="font-semibold text-blue-700 mb-3">주의해야 할 요인</h3>
            <div v-for="f in accuracy.worstFactors" :key="f.factor" class="flex items-center justify-between py-2 border-b border-border-subtle last:border-0">
              <span class="text-sm text-txt-primary">{{ f.factor }}</span>
              <span class="text-sm font-bold text-loss">{{ f.winRate }}% <span class="text-xs text-txt-tertiary font-normal">({{ f.count }}건)</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 가중치 관리 -->
    <div v-if="activeTab === 'weights'">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- 현재 가중치 -->
        <div class="bg-surface-1 rounded-xl border border-border p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-semibold text-txt-primary">현재 가중치</h3>
            <div class="flex gap-2">
              <button @click="runOptimize" :disabled="optimizing"
                class="px-3 py-1.5 bg-primary text-white rounded-lg text-xs hover:bg-primary-hover disabled:opacity-50">
                {{ optimizing ? '최적화 중...' : '수동 최적화' }}
              </button>
              <button @click="doResetWeights"
                class="px-3 py-1.5 border border-border text-txt-secondary rounded-lg text-xs hover:bg-surface-2">
                초기화
              </button>
            </div>
          </div>
          <div class="space-y-2">
            <div v-for="(value, key) in weights" :key="key"
              class="flex items-center justify-between py-2 px-3 rounded-lg"
              :class="value > 1.05 ? 'bg-red-50' : value < 0.95 ? 'bg-blue-50' : 'bg-surface-2'">
              <span class="text-sm text-txt-primary">{{ formatWeightName(key as string) }}</span>
              <span class="text-sm font-mono font-bold"
                :class="value > 1.05 ? 'text-profit' : value < 0.95 ? 'text-loss' : 'text-txt-secondary'">
                {{ value }}
              </span>
            </div>
          </div>
          <!-- 최적화 결과 -->
          <div v-if="optimizeResult" class="mt-4 p-3 rounded-lg bg-green-50 border border-green-200">
            <p class="text-sm font-medium text-green-800">
              {{ optimizeResult.adjusted.length > 0 ? `${optimizeResult.adjusted.length}개 가중치 조정 완료` : '조정 필요 없음' }}
            </p>
            <p v-if="optimizeResult.skipped" class="text-xs text-green-600 mt-1">{{ optimizeResult.skipped }}</p>
            <div v-for="a in optimizeResult.adjusted" :key="a.scoreType" class="text-xs text-green-700 mt-1">
              {{ formatWeightName(a.scoreType) }}: {{ a.oldWeight }} -> {{ a.newWeight }} (r={{ a.correlation }})
            </div>
          </div>
        </div>

        <!-- 변경 이력 -->
        <div class="bg-surface-1 rounded-xl border border-border p-5">
          <h3 class="font-semibold text-txt-primary mb-4">변경 이력</h3>
          <div v-if="weightsHistory.length === 0" class="text-center py-8 text-txt-tertiary text-sm">변경 이력이 없습니다</div>
          <div v-else class="space-y-2 max-h-96 overflow-y-auto">
            <div v-for="h in weightsHistory" :key="h.id" class="p-3 bg-surface-2 rounded-lg">
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-txt-primary">{{ formatWeightName(h.score_type) }}</span>
                <span class="text-xs text-txt-tertiary">{{ formatDate(h.created_at) }}</span>
              </div>
              <div class="flex items-center gap-2 mt-1">
                <span class="text-xs font-mono text-txt-secondary">{{ h.old_weight }}</span>
                <span class="text-xs text-txt-tertiary">-></span>
                <span class="text-xs font-mono font-bold"
                  :class="h.new_weight > h.old_weight ? 'text-profit' : 'text-loss'">
                  {{ h.new_weight }}
                </span>
                <span class="text-xs text-txt-tertiary ml-1">(r={{ h.correlation }}, n={{ h.sample_size }})</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 백테스트 -->
    <div v-if="activeTab === 'backtest'">
      <!-- 과거 백테스트 결과 목록 -->
      <div class="bg-surface-1 rounded-xl border border-border overflow-hidden">
        <div class="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 class="font-semibold text-txt-primary">백테스트 결과</h3>
          <button @click="loadBacktests" class="text-xs text-accent hover:underline">새로고침</button>
        </div>
        <div v-if="backtests.length === 0" class="text-center py-16 text-txt-tertiary">
          <p class="text-4xl mb-3">🧪</p>
          <p>백테스트 결과가 없습니다</p>
          <p class="text-xs mt-1">API를 통해 백테스트를 실행하면 여기에 표시됩니다</p>
        </div>
        <table v-else class="w-full text-sm table-fixed">
          <colgroup>
            <col style="width: 180px" />
            <col style="width: 100px" />
            <col style="width: 100px" />
            <col style="width: 90px" />
            <col style="width: 90px" />
            <col style="width: 80px" />
            <col style="width: 80px" />
            <col style="width: 90px" />
            <col />
          </colgroup>
          <thead>
            <tr class="text-left text-xs text-txt-secondary border-b border-border-subtle">
              <th class="px-4 py-3 whitespace-nowrap">이름</th>
              <th class="px-4 py-3 whitespace-nowrap">시작일</th>
              <th class="px-4 py-3 whitespace-nowrap">종료일</th>
              <th class="px-4 py-3 whitespace-nowrap text-right">수익률</th>
              <th class="px-4 py-3 whitespace-nowrap text-right">MDD</th>
              <th class="px-4 py-3 whitespace-nowrap text-right">승률</th>
              <th class="px-4 py-3 whitespace-nowrap text-right">샤프</th>
              <th class="px-4 py-3 whitespace-nowrap text-right">거래수</th>
              <th class="px-4 py-3 whitespace-nowrap">실행일</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bt in backtests" :key="bt.id"
              class="border-b border-border-subtle hover:bg-surface-2 cursor-pointer"
              @click="selectedBacktest = selectedBacktest?.id === bt.id ? null : bt">
              <td class="px-4 py-3 font-medium text-txt-primary truncate" :title="bt.name">{{ bt.name }}</td>
              <td class="px-4 py-3 text-txt-secondary">{{ bt.start_date }}</td>
              <td class="px-4 py-3 text-txt-secondary">{{ bt.end_date }}</td>
              <td class="px-4 py-3 text-right font-bold"
                :class="bt.total_return >= 0 ? 'text-profit' : 'text-loss'">
                {{ bt.total_return >= 0 ? '+' : '' }}{{ bt.total_return }}%
              </td>
              <td class="px-4 py-3 text-right text-loss">-{{ bt.max_drawdown }}%</td>
              <td class="px-4 py-3 text-right text-txt-primary">{{ bt.win_rate }}%</td>
              <td class="px-4 py-3 text-right text-txt-primary">{{ bt.sharpe_ratio ?? '-' }}</td>
              <td class="px-4 py-3 text-right text-txt-secondary">{{ bt.total_trades }}건</td>
              <td class="px-4 py-3 text-xs text-txt-tertiary">{{ formatDate(bt.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 선택된 백테스트 상세 -->
      <div v-if="selectedBacktest" class="mt-6 bg-surface-1 rounded-xl border border-border p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-semibold text-txt-primary">{{ selectedBacktest.name }} - 상세 정보</h3>
          <button @click="selectedBacktest = null" class="text-txt-tertiary hover:text-txt-secondary text-lg">&times;</button>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">총 수익률</p>
            <p class="text-lg font-bold" :class="selectedBacktest.total_return >= 0 ? 'text-profit' : 'text-loss'">
              {{ selectedBacktest.total_return >= 0 ? '+' : '' }}{{ selectedBacktest.total_return }}%
            </p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">최대 낙폭 (MDD)</p>
            <p class="text-lg font-bold text-loss">-{{ selectedBacktest.max_drawdown }}%</p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">승률</p>
            <p class="text-lg font-bold text-txt-primary">{{ selectedBacktest.win_rate }}%</p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg">
            <p class="text-xs text-txt-secondary">손익비 (Profit Factor)</p>
            <p class="text-lg font-bold text-txt-primary">{{ selectedBacktest.profit_factor ?? '-' }}</p>
          </div>
        </div>
        <div v-if="backtestDetail" class="grid grid-cols-3 gap-4">
          <div class="p-3 bg-surface-2 rounded-lg text-center">
            <p class="text-xs text-txt-secondary">총 거래</p>
            <p class="text-lg font-bold text-txt-primary">{{ backtestDetail.total_trades }}건</p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg text-center">
            <p class="text-xs text-txt-secondary">평균 수익 (승)</p>
            <p class="text-lg font-bold text-profit">{{ backtestDetail.avg_win?.toLocaleString() || 0 }}</p>
          </div>
          <div class="p-3 bg-surface-2 rounded-lg text-center">
            <p class="text-xs text-txt-secondary">평균 손실 (패)</p>
            <p class="text-lg font-bold text-loss">{{ backtestDetail.avg_loss?.toLocaleString() || 0 }}</p>
          </div>
        </div>
        <!-- 거래 내역 -->
        <div v-if="backtestDetail?.results_json?.length > 0" class="mt-4">
          <h4 class="text-sm font-medium text-txt-primary mb-2">거래 내역 (최근 {{ backtestDetail.results_json.length }}건)</h4>
          <div class="max-h-64 overflow-y-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-txt-secondary border-b">
                  <th class="px-3 py-2">날짜</th>
                  <th class="px-3 py-2">유형</th>
                  <th class="px-3 py-2 text-right">가격</th>
                  <th class="px-3 py-2 text-right">수량</th>
                  <th class="px-3 py-2">사유</th>
                  <th class="px-3 py-2 text-right">손익</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(trade, i) in backtestDetail.results_json" :key="i" class="border-b border-border-subtle">
                  <td class="px-3 py-2 text-txt-secondary">{{ trade.date }}</td>
                  <td class="px-3 py-2">
                    <span class="px-1.5 py-0.5 rounded text-xs font-medium"
                      :class="trade.type === 'BUY' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'">
                      {{ trade.type }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right text-txt-primary">{{ trade.price?.toLocaleString() }}</td>
                  <td class="px-3 py-2 text-right text-txt-primary">{{ trade.quantity }}</td>
                  <td class="px-3 py-2 text-txt-secondary truncate max-w-[200px]" :title="trade.reason">{{ trade.reason }}</td>
                  <td class="px-3 py-2 text-right font-medium"
                    :class="trade.pnl > 0 ? 'text-profit' : trade.pnl < 0 ? 'text-loss' : 'text-txt-tertiary'">
                    {{ trade.pnl !== undefined ? (trade.pnl >= 0 ? '+' : '') + Math.round(trade.pnl).toLocaleString() : '' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- 수동 학습 / 복구 실행 -->
    <div class="bg-surface-1 rounded-xl border border-border shadow-sm p-5 mt-6">
      <h3 class="font-semibold text-txt-primary mb-3">수동 실행</h3>
      <p class="text-xs text-txt-secondary mb-4">
        스케줄러가 주기적으로 자동 실행하지만, 아래 버튼으로 즉시 트리거할 수 있다.
      </p>
      <div class="flex flex-wrap gap-2">
        <button @click="doRunWeekendLearning" :disabled="runningJob !== null"
          class="px-3 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {{ runningJob === 'weekend' ? '실행 중...' : '주말 학습 실행' }}
        </button>
        <button @click="doEvaluatePerformance" :disabled="runningJob !== null"
          class="px-3 py-2 bg-surface-3 text-txt-primary rounded-lg text-sm font-medium hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {{ runningJob === 'evaluate' ? '평가 중...' : '성과 평가 실행' }}
        </button>
        <button @click="doBackfillUntracked" :disabled="runningJob !== null"
          class="px-3 py-2 bg-surface-3 text-txt-primary rounded-lg text-sm font-medium hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {{ runningJob === 'backfill' ? '복구 중...' : '과거 신호 복구' }}
        </button>
      </div>
      <p v-if="jobResult" class="mt-3 text-sm text-txt-primary">
        {{ jobResult }}
      </p>
      <p class="mt-3 text-xs text-txt-tertiary">
        <strong>주말 학습</strong>: 성과 평가 + 가중치 최적화 + 리포트 생성 (Ollama 호출 2분 이상 소요)<br />
        <strong>성과 평가</strong>: 7/14/30일 경과 신호의 실제 가격 변동 업데이트<br />
        <strong>과거 신호 복구</strong>: v4.8.1 이전 누락된 신호를 실제 체결가 기반으로 복구
      </p>
    </div>

    <!-- 주간 학습 리포트 -->
    <div class="bg-surface-1 rounded-xl border border-border shadow-sm p-5 mt-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-txt-primary">주간 학습 리포트</h3>
        <button @click="loadWeeklyReports" class="text-xs text-accent hover:underline">새로고침</button>
      </div>
      <div v-if="weeklyReports.length === 0" class="text-center py-8 text-txt-tertiary text-sm">
        아직 생성된 주간 리포트가 없습니다 (토요일 06:00 자동 생성)
      </div>
      <div v-else class="space-y-3">
        <div v-for="r in weeklyReports" :key="r.id" class="border border-border-subtle rounded-lg p-4">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-txt-tertiary">{{ r.created_at?.slice(0, 10) }}</span>
            <div v-if="r.stats_json" class="flex gap-3 text-xs text-txt-secondary">
              <span>신호 {{ r.stats_json.totalSignals || 0 }}건</span>
              <span>체결 {{ r.stats_json.tradesExecuted || 0 }}건</span>
              <span>신뢰도 {{ Math.round(r.stats_json.avgConfidence || 0) }}%</span>
            </div>
          </div>
          <p class="text-sm text-txt-primary whitespace-pre-line">{{ r.report }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, inject, type Ref } from 'vue';
import { feedbackApi } from '@/api';

interface ToastShowOpts { type?: string; title?: string; message: string; duration?: number; }
interface ToastInstance { show: (opts: ToastShowOpts) => void; }
const toastRef = inject<Ref<ToastInstance | null> | null>('toast', null);

const tabs = [
  { value: 'performance', label: '성과 요약' },
  { value: 'accuracy', label: '정확도 분석' },
  { value: 'weights', label: '가중치 관리' },
  { value: 'backtest', label: '백테스트' },
];

const activeTab = ref('performance');
const analysisDays = ref(90);
const loading = ref(false);
const weeklyReports = ref<any[]>([]);

async function loadWeeklyReports() {
  try {
    const { data } = await feedbackApi.getWeeklyReports({ limit: 5 });
    weeklyReports.value = data;
  } catch {}
}

// 성과 데이터
const perf = ref<any>({});
const accuracy = ref<any>({ totalEvaluated: 0, byConfidence: [], byMarket: [], bestFactors: [], worstFactors: [] });

// 가중치 데이터
const weights = ref<Record<string, number>>({});
const weightsHistory = ref<any[]>([]);
const optimizing = ref(false);
const optimizeResult = ref<any>(null);

// 백테스트 데이터
const backtests = ref<any[]>([]);
const selectedBacktest = ref<any>(null);
const backtestDetail = ref<any>(null);

const WEIGHT_NAMES: Record<string, string> = {
  CONSECUTIVE_BUY: '연속 BUY 신호',
  HIGH_CONFIDENCE: '높은 신뢰도',
  VOLUME_SURGE: '거래량 급증',
  RSI_OVERSOLD_BOUNCE: 'RSI 과매도 반등',
  BOLLINGER_BOUNCE: '볼린저 하단 반등',
  MACD_GOLDEN_CROSS: 'MACD 골든크로스',
  PRICE_MOMENTUM: '가격 모멘텀',
  NEWS_POSITIVE: '뉴스 호재',
  TIME_DECAY: '시간 감쇠',
};

function formatWeightName(key: string): string {
  return WEIGHT_NAMES[key] || key;
}

function formatDate(dt: string): string {
  if (!dt) return '-';
  return new Date(dt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadPerformance() {
  loading.value = true;
  try {
    const { data } = await feedbackApi.getPerformance({ days: analysisDays.value });
    perf.value = data;
  } catch { /* */ }
  loading.value = false;
}

async function loadAccuracy() {
  loading.value = true;
  try {
    const { data } = await feedbackApi.getAccuracy({ days: analysisDays.value });
    accuracy.value = data;
  } catch { /* */ }
  loading.value = false;
}

async function loadWeights() {
  try {
    const [wRes, hRes] = await Promise.all([
      feedbackApi.getWeights(),
      feedbackApi.getWeightsHistory({ limit: 30 }),
    ]);
    weights.value = wRes.data;
    weightsHistory.value = hRes.data;
  } catch { /* */ }
}

async function loadBacktests() {
  try {
    const { data } = await feedbackApi.getBacktestList({ limit: 20 });
    backtests.value = data;
  } catch { /* */ }
}

async function runOptimize() {
  optimizing.value = true;
  optimizeResult.value = null;
  try {
    const { data } = await feedbackApi.optimizeWeights();
    optimizeResult.value = data;
    await loadWeights();
  } catch { /* */ }
  optimizing.value = false;
}

async function doResetWeights() {
  if (!confirm('가중치를 모두 1.0으로 초기화하시겠습니까?')) return;
  try {
    const { data } = await feedbackApi.resetWeights();
    weights.value = data.weights;
    optimizeResult.value = null;
    await loadWeights();
  } catch { /* */ }
}

async function loadAll() {
  if (activeTab.value === 'performance') await loadPerformance();
  else if (activeTab.value === 'accuracy') await loadAccuracy();
  else if (activeTab.value === 'weights') await loadWeights();
  else if (activeTab.value === 'backtest') await loadBacktests();
}

// ─── 수동 실행 핸들러 ─────────────────────────────────
const runningJob = ref<'weekend' | 'evaluate' | 'backfill' | null>(null);
const jobResult = ref<string>('');

async function doRunWeekendLearning() {
  if (!confirm('주말 학습을 실행하시겠습니까? Ollama 호출이 포함되어 있어 2분 이상 소요될 수 있습니다.')) return;
  runningJob.value = 'weekend';
  jobResult.value = '';
  try {
    const { data } = await feedbackApi.runWeekendLearning();
    jobResult.value = `✅ ${data.message}`;
    await loadWeeklyReports();
    await loadAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '실행 실패';
    jobResult.value = `❌ ${msg}`;
    toastRef?.value?.show({ type: 'error', title: '주말 학습 실패', message: msg });
  }
  runningJob.value = null;
}

async function doEvaluatePerformance() {
  runningJob.value = 'evaluate';
  jobResult.value = '';
  try {
    const { data } = await feedbackApi.evaluatePerformance();
    jobResult.value = `✅ ${data.message}`;
    await loadAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '평가 실패';
    jobResult.value = `❌ ${msg}`;
    toastRef?.value?.show({ type: 'error', title: '성과 평가 실패', message: msg });
  }
  runningJob.value = null;
}

async function doBackfillUntracked() {
  if (!confirm('과거 신호 복구: auto_trades/transactions의 체결가를 signalPrice로 사용하여 signal_performance를 채웁니다. 계속하시겠습니까?')) return;
  runningJob.value = 'backfill';
  jobResult.value = '';
  try {
    const { data } = await feedbackApi.backfillUntracked();
    jobResult.value = `✅ ${data.message}`;
    await loadAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '복구 실패';
    jobResult.value = `❌ ${msg}`;
    toastRef?.value?.show({ type: 'error', title: '복구 실패', message: msg });
  }
  runningJob.value = null;
}

watch(activeTab, loadAll);

watch(selectedBacktest, async (bt) => {
  if (bt) {
    try {
      const { data } = await feedbackApi.getBacktestDetail(bt.id);
      backtestDetail.value = data;
    } catch { /* */ }
  } else {
    backtestDetail.value = null;
  }
});

onMounted(() => {
  loadAll();
  loadWeeklyReports();
});
</script>
