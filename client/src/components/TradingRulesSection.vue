<template>
  <div class="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
    <div class="px-6 py-4 bg-slate-50 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-600">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">매매 원칙 (14 Rules)</h3>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">AI 매매 신호에 자동 적용되는 규칙 기반 필터입니다.</p>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <div class="relative">
            <input type="checkbox" :checked="tradingRulesEnabled" @change="$emit('update:tradingRulesEnabled', ($event.target as HTMLInputElement).checked)" class="sr-only" />
            <div class="w-11 h-6 rounded-full transition-colors" :class="tradingRulesEnabled ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-600'"></div>
            <div class="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="tradingRulesEnabled ? 'translate-x-5' : 'translate-x-0'"></div>
          </div>
          <span class="text-sm font-medium text-slate-700 dark:text-slate-200">활성화</span>
        </label>
      </div>
    </div>

    <div v-if="tradingRulesEnabled" class="p-6 space-y-6">
      <!-- 엄격 모드 토글 -->
      <div class="flex items-center justify-between p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
        <div>
          <span class="text-sm font-medium text-amber-800 dark:text-amber-300">엄격 모드</span>
          <p class="text-xs text-amber-600 dark:text-amber-400 mt-0.5">규칙에 위반되는 신호를 완전 차단합니다 (OFF 시 신뢰도만 조정)</p>
        </div>
        <label class="cursor-pointer">
          <div class="relative">
            <input type="checkbox" :checked="tradingRulesStrictMode" @change="$emit('update:tradingRulesStrictMode', ($event.target as HTMLInputElement).checked)" class="sr-only" />
            <div class="w-9 h-5 rounded-full transition-colors" :class="tradingRulesStrictMode ? 'bg-amber-600' : 'bg-slate-200 dark:bg-slate-600'"></div>
            <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" :class="tradingRulesStrictMode ? 'translate-x-4' : 'translate-x-0'"></div>
          </div>
        </label>
      </div>

      <!-- 임계값 설정 -->
      <div class="space-y-4">
        <h4 class="text-sm font-semibold text-slate-700 dark:text-slate-200">임계값 설정</h4>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">갭 임계값 (%)</label>
            <input
              type="number"
              :value="gapThresholdPercent"
              @input="$emit('update:gapThresholdPercent', Number(($event.target as HTMLInputElement).value))"
              min="0.5" max="20" step="0.5"
              class="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">폭등/폭락 판단 기준</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">거래량 급증 비율</label>
            <input
              type="number"
              :value="volumeSurgeRatio"
              @input="$emit('update:volumeSurgeRatio', Number(($event.target as HTMLInputElement).value))"
              min="1.0" max="5.0" step="0.1"
              class="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">20일 평균 대비 배수</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">저거래량 비율</label>
            <input
              type="number"
              :value="lowVolumeRatio"
              @input="$emit('update:lowVolumeRatio', Number(($event.target as HTMLInputElement).value))"
              min="0.1" max="1.0" step="0.1"
              class="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">관망 판단 기준</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">횡보 ATR (%)</label>
            <input
              type="number"
              :value="sidewaysAtrPercent"
              @input="$emit('update:sidewaysAtrPercent', Number(($event.target as HTMLInputElement).value))"
              min="0.1" max="5.0" step="0.1"
              class="w-full border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-lg px-3 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">횡보장 판단 기준</p>
          </div>
        </div>
      </div>

      <!-- 규칙 목록 (카테고리별 그룹) -->
      <div v-if="loading" class="text-center py-8">
        <div class="inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-2">규칙 로딩 중...</p>
      </div>

      <div v-else class="space-y-4">
        <div v-for="group in groupedRules" :key="group.category">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              :class="categoryBadgeClass(group.category)">
              {{ categoryLabel(group.category) }}
            </span>
            <span class="text-xs text-slate-400 dark:text-slate-500">{{ group.rules.length }}개 규칙</span>
          </div>
          <div class="space-y-1">
            <div
              v-for="rule in group.rules"
              :key="rule.rule_id"
              class="flex items-center justify-between px-4 py-3 rounded-lg border transition-colors"
              :class="rule.is_enabled
                ? 'bg-white dark:bg-slate-700/50 border-slate-200 dark:border-slate-600'
                : 'bg-slate-50 dark:bg-slate-800/50 border-slate-100 dark:border-slate-700 opacity-60'"
            >
              <div class="flex-1 min-w-0 mr-3">
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{{ rule.name }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ rule.description }}</div>
              </div>
              <label class="cursor-pointer flex-shrink-0">
                <div class="relative">
                  <input
                    type="checkbox"
                    :checked="rule.is_enabled"
                    @change="toggleRule(rule.rule_id, !rule.is_enabled)"
                    class="sr-only"
                  />
                  <div class="w-9 h-5 rounded-full transition-colors"
                    :class="rule.is_enabled ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-600'"></div>
                  <div class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
                    :class="rule.is_enabled ? 'translate-x-4' : 'translate-x-0'"></div>
                </div>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- 에러 메시지 -->
      <div v-if="errorMsg" class="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
        <p class="text-xs text-red-600 dark:text-red-400">{{ errorMsg }}</p>
      </div>
    </div>

    <div v-else class="p-6">
      <p class="text-sm text-slate-500 dark:text-slate-400">매매 원칙이 비활성화되어 있습니다. AI 신호가 필터 없이 그대로 적용됩니다.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { tradingRulesApi } from '@/api';
import type { TradingRule } from '@/types';

interface Props {
  tradingRulesEnabled: boolean;
  tradingRulesStrictMode: boolean;
  gapThresholdPercent: number;
  volumeSurgeRatio: number;
  lowVolumeRatio: number;
  sidewaysAtrPercent: number;
}

defineProps<Props>();

defineEmits<{
  'update:tradingRulesEnabled': [value: boolean];
  'update:tradingRulesStrictMode': [value: boolean];
  'update:gapThresholdPercent': [value: number];
  'update:volumeSurgeRatio': [value: number];
  'update:lowVolumeRatio': [value: number];
  'update:sidewaysAtrPercent': [value: number];
}>();

const rules = ref<TradingRule[]>([]);
const loading = ref(false);
const errorMsg = ref('');

const categoryLabels: Record<string, string> = {
  TIME: '시간 기반 규칙',
  VOLUME: '거래량 기반 규칙',
  VOLATILITY: '변동성 규칙',
  CANDLE: '캔들 패턴 규칙',
  SUPPORT: '지지선 규칙',
};

const categoryBadgeClasses: Record<string, string> = {
  TIME: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  VOLUME: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  VOLATILITY: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  CANDLE: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  SUPPORT: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function categoryLabel(cat: string): string {
  return categoryLabels[cat] || cat;
}

function categoryBadgeClass(cat: string): string {
  return categoryBadgeClasses[cat] || 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
}

interface RuleGroup {
  category: string;
  rules: TradingRule[];
}

const groupedRules = computed<RuleGroup[]>(() => {
  const order = ['TIME', 'VOLUME', 'VOLATILITY', 'CANDLE', 'SUPPORT'];
  const grouped = new Map<string, TradingRule[]>();

  for (const rule of rules.value) {
    const cat = rule.category;
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push(rule);
  }

  return order
    .filter(cat => grouped.has(cat))
    .map(cat => ({
      category: cat,
      rules: grouped.get(cat)!,
    }));
});

async function loadRules() {
  loading.value = true;
  errorMsg.value = '';
  try {
    const { data } = await tradingRulesApi.getAll();
    rules.value = data;
  } catch (err: any) {
    errorMsg.value = err.response?.data?.error || '규칙 로딩 실패';
  }
  loading.value = false;
}

async function toggleRule(ruleId: string, enabled: boolean) {
  errorMsg.value = '';
  try {
    await tradingRulesApi.update(ruleId, { is_enabled: enabled });
    const idx = rules.value.findIndex(r => r.rule_id === ruleId);
    if (idx !== -1) {
      rules.value = [
        ...rules.value.slice(0, idx),
        { ...rules.value[idx], is_enabled: enabled },
        ...rules.value.slice(idx + 1),
      ];
    }
  } catch (err: any) {
    errorMsg.value = err.response?.data?.error || '규칙 업데이트 실패';
    await loadRules();
  }
}

onMounted(() => {
  loadRules();
});
</script>
