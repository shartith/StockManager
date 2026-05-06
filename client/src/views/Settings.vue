<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-2xl font-bold text-txt-primary">설정</h2>
      <p class="text-sm text-txt-tertiary mt-0.5">v5.2.0 — 12-Rule 심플 매매 전략</p>
    </div>

    <!-- 데이터 새로고침 -->
    <div class="solid-card p-5">
      <h3 class="text-sm font-semibold text-txt-primary mb-3">데이터 새로고침</h3>
      <select v-model.number="refreshInterval" @change="onRefreshIntervalChange"
        class="w-full md:w-64 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
        <option v-for="opt in refreshOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <!-- KIS API -->
    <div class="solid-card p-5 space-y-4">
      <h3 class="text-sm font-semibold text-txt-primary">KIS API</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">App Key</label>
          <input v-model="form.appKey" type="text"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">App Secret {{ form.hasSecret ? '(저장됨, 변경 시만 입력)' : '' }}</label>
          <input v-model="form.appSecret" type="password" :placeholder="form.hasSecret ? '*****' : ''"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">계좌번호</label>
          <input v-model="form.accountNo" type="text"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">상품코드</label>
          <input v-model="form.accountProductCode" type="text" placeholder="01"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
      </div>
      <ToggleSwitch v-model="form.isVirtual" label="모의투자 사용" />
    </div>

    <!-- LLM (Rule 12 / 뉴스 요약 전용) -->
    <div class="solid-card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-txt-primary">LLM (Rule 12 / 뉴스 요약 전용)</h3>
        <ToggleSwitch v-model="form.llmEnabled" />
      </div>
      <p class="text-xs text-txt-tertiary">v5에서 LLM은 매매 판단에 직접 사용하지 않음. 저평가 후보 추천 + 뉴스 요약만 담당.</p>
      <div v-if="form.llmEnabled" class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">서버 URL (/v1 포함)</label>
          <input v-model="form.llmUrl" type="text" placeholder="https://ai.unids.kr/v1"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">모델명 (빈 값 = 자동선택)</label>
          <input v-model="form.llmModel" type="text"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div class="md:col-span-2">
          <label class="block text-xs font-medium text-txt-secondary mb-1">API Key {{ form.hasLlmApiKey ? '(저장됨, 변경 시만 입력)' : '' }}</label>
          <input v-model="form.llmApiKey" type="password" :placeholder="form.hasLlmApiKey ? '*****' : ''"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
      </div>
    </div>

    <!-- DART -->
    <div class="solid-card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-txt-primary">DART 공시 감시</h3>
        <ToggleSwitch v-model="form.dartEnabled" />
      </div>
      <div v-if="form.dartEnabled">
        <label class="block text-xs font-medium text-txt-secondary mb-1">DART API Key {{ form.hasDartKey ? '(저장됨)' : '' }}</label>
        <input v-model="form.dartApiKey" type="password" :placeholder="form.hasDartKey ? '*****' : ''"
          class="w-full md:w-2/3 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
    </div>

    <!-- 자동매매 — ON/OFF + 스케줄 토글만 -->
    <div class="solid-card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-txt-primary">자동매매</h3>
        <ToggleSwitch v-model="form.autoTradeEnabled" />
      </div>
      <p class="text-xs text-txt-tertiary">
        매매 한도는 KIS 잔고와 종목당 운영 수량으로 자동 산정됩니다.
      </p>
      <div class="pt-2 border-t border-border-subtle">
        <ToggleSwitch v-model="form.scheduleKrx.enabled">
          <span class="text-sm text-txt-secondary">
            KRX 스케줄러 — 08:50 자동목록 빌드 → 09:05~09:55 매수창 → 10:00~14:55 모니터 → 15:00 익절 / 15:20 EOD 정리 / 15:50 reconcile
          </span>
        </ToggleSwitch>
      </div>
    </div>

    <!-- 매수 전략 -->
    <div class="solid-card p-5 space-y-3">
      <h3 class="text-sm font-semibold text-txt-primary">매수 전략 (Rule 4, 5 + 시장 보호)</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">동시 보유 종목 수 (Rule 4)</label>
          <input v-model.number="form.positionMaxPositions" type="number" min="1" max="20"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
          <p class="text-xs text-txt-tertiary mt-1">예산을 N등분 (±5% 허용), 한도 초과 종목은 1주만 매수</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">시초가 대비 매수 트리거 (%) — Rule 5</label>
          <input v-model.number="form.entryGainPercent" type="number" min="0.1" step="0.1"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">갭상승 제외 임계값 (%)</label>
          <input v-model.number="form.gapUpMaxPercent" type="number" min="0.5" step="0.5"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
          <p class="text-xs text-txt-tertiary mt-1">전일 대비 N% 이상 갭상승 종목은 자동목록 제외</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">재진입 cooldown (분)</label>
          <input v-model.number="form.reEntryCooldownMinutes" type="number" min="0" step="5"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
      </div>
      <div class="pt-3 border-t border-border-subtle space-y-3">
        <ToggleSwitch v-model="form.marketBrakeEnabled">
          <span class="text-sm text-txt-secondary">🚨 시장 브레이크 — KOSPI/VIX 폭락 시 신규 매수 차단</span>
        </ToggleSwitch>
        <div v-if="form.marketBrakeEnabled" class="grid grid-cols-2 gap-3 pl-6">
          <div>
            <label class="block text-xs font-medium text-txt-secondary mb-1">KOSPI 차단 임계 (%)</label>
            <input v-model.number="form.marketBrakeKospiPercent" type="number" min="0.5" step="0.5"
              class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label class="block text-xs font-medium text-txt-secondary mb-1">VIX 차단 임계</label>
            <input v-model.number="form.marketBrakeVixLevel" type="number" min="15" step="1"
              class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
        </div>
      </div>
    </div>

    <!-- 매도 규칙 -->
    <div class="solid-card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-txt-primary">매도 규칙 (Rule 6~11)</h3>
        <ToggleSwitch v-model="form.sellRulesEnabled" />
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">목표 수익률 (%) — Rule 7-1</label>
          <input v-model.number="form.targetProfitRate" type="number" min="0.1" step="0.1"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">손절선 (%) — Rule 6</label>
          <input v-model.number="form.hardStopLossRate" type="number" min="0.1" step="0.1"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">트레일링 폭 (%) — Rule 7-2</label>
          <input v-model.number="form.trailingStopRate" type="number" min="0.1" step="0.1"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">트레일링 활성 임계 (%)</label>
          <input v-model.number="form.trailingActivatePercent" type="number" min="0.5" step="0.5"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
          <p class="text-xs text-txt-tertiary mt-1">+N% 도달 후에만 트레일링 활성 (sticky)</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">정체 시간 (분) — Rule 7+8</label>
          <input v-model.number="form.sidewaysMinutes" type="number" min="5"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">손실 강제손절 시간 (분) — Rule 9</label>
          <input v-model.number="form.lossMinutes" type="number" min="5"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">EOD 익절 임계 (%) — Rule 10</label>
          <input v-model.number="form.eodProfitTakePercent" type="number" min="0.5" step="0.5"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">수익 정의 임계 (%)</label>
          <input v-model.number="form.profitThresholdPercent" type="number" min="0" step="0.1"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent" />
          <p class="text-xs text-txt-tertiary mt-1">수수료 보전 — 이 값 미만은 손익무관 처리</p>
        </div>
      </div>
    </div>

    <!-- 저장 -->
    <div class="flex items-center justify-between sticky bottom-0 py-4 bg-surface backdrop-blur">
      <p v-if="saveMessage" class="text-sm" :class="saveError ? 'text-loss' : 'text-profit'">{{ saveMessage }}</p>
      <button @click="save" :disabled="saving"
        class="ml-auto px-6 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
        {{ saving ? '저장 중…' : '설정 저장' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { chartApi } from '@/api';
import { setRefreshInterval, getRefreshInterval } from '@/composables/useAutoRefresh';
import ToggleSwitch from '@/components/ToggleSwitch.vue';

const refreshOptions = [
  { label: '10초', value: 10000 },
  { label: '30초', value: 30000 },
  { label: '60초', value: 60000 },
  { label: '수동', value: 0 },
];
const refreshInterval = ref(getRefreshInterval());
function onRefreshIntervalChange() {
  setRefreshInterval(refreshInterval.value);
}

interface FormState {
  appKey: string;
  appSecret: string;
  hasSecret: boolean;
  accountNo: string;
  accountProductCode: string;
  isVirtual: boolean;
  mcpEnabled: boolean;
  llmProvider: 'openai' | 'ollama';
  llmUrl: string;
  llmModel: string;
  llmEnabled: boolean;
  llmApiKey: string;
  hasLlmApiKey: boolean;
  dartApiKey: string;
  dartEnabled: boolean;
  hasDartKey: boolean;
  autoTradeEnabled: boolean;
  scheduleKrx: { enabled: boolean };
  sellRulesEnabled: boolean;
  targetProfitRate: number;
  hardStopLossRate: number;
  trailingStopRate: number;
  trailingActivatePercent: number;
  sidewaysMinutes: number;
  lossMinutes: number;
  profitThresholdPercent: number;
  positionMaxPositions: number;
  eodProfitTakePercent: number;
  entryGainPercent: number;
  marketBrakeEnabled: boolean;
  marketBrakeKospiPercent: number;
  marketBrakeVixLevel: number;
  gapUpMaxPercent: number;
  reEntryCooldownMinutes: number;
}

const form = ref<FormState>({
  appKey: '', appSecret: '', hasSecret: false,
  accountNo: '', accountProductCode: '01', isVirtual: true, mcpEnabled: false,
  llmProvider: 'openai', llmUrl: 'https://ai.unids.kr/v1', llmModel: '',
  llmEnabled: true, llmApiKey: '', hasLlmApiKey: false,
  dartApiKey: '', dartEnabled: false, hasDartKey: false,
  autoTradeEnabled: false,
  scheduleKrx: { enabled: false },
  sellRulesEnabled: true,
  targetProfitRate: 3.0,
  hardStopLossRate: 2.0,
  trailingStopRate: 1.5,
  trailingActivatePercent: 3.0,
  sidewaysMinutes: 60,
  lossMinutes: 60,
  profitThresholdPercent: 0.5,
  positionMaxPositions: 5,
  eodProfitTakePercent: 3.0,
  entryGainPercent: 1.0,
  marketBrakeEnabled: true,
  marketBrakeKospiPercent: 2.0,
  marketBrakeVixLevel: 30,
  gapUpMaxPercent: 3.0,
  reEntryCooldownMinutes: 30,
});

const saving = ref(false);
const saveMessage = ref('');
const saveError = ref(false);

async function loadConfig() {
  try {
    const { data } = await chartApi.getFormConfig();
    Object.assign(form.value, {
      appKey: data.appKey || '',
      hasSecret: data.hasSecret,
      accountNo: data.accountNo || '',
      accountProductCode: data.accountProductCode || '01',
      isVirtual: data.isVirtual,
      mcpEnabled: data.mcpEnabled,
      llmProvider: data.llmProvider || 'openai',
      llmUrl: data.llmUrl || 'https://ai.unids.kr/v1',
      llmModel: data.llmModel || '',
      llmEnabled: data.llmEnabled !== false,
      hasLlmApiKey: data.hasLlmApiKey,
      dartEnabled: data.dartEnabled,
      hasDartKey: data.hasDartKey,
      autoTradeEnabled: data.autoTradeEnabled,
      scheduleKrx: data.scheduleKrx ?? { enabled: false },
      sellRulesEnabled: data.sellRulesEnabled,
      targetProfitRate: data.targetProfitRate,
      hardStopLossRate: data.hardStopLossRate,
      trailingStopRate: data.trailingStopRate,
      trailingActivatePercent: data.trailingActivatePercent,
      sidewaysMinutes: data.sidewaysMinutes,
      lossMinutes: data.lossMinutes,
      profitThresholdPercent: data.profitThresholdPercent,
      positionMaxPositions: data.positionMaxPositions,
      eodProfitTakePercent: data.eodProfitTakePercent,
      entryGainPercent: data.entryGainPercent,
      marketBrakeEnabled: data.marketBrakeEnabled ?? true,
      marketBrakeKospiPercent: data.marketBrakeKospiPercent,
      marketBrakeVixLevel: data.marketBrakeVixLevel,
      gapUpMaxPercent: data.gapUpMaxPercent,
      reEntryCooldownMinutes: data.reEntryCooldownMinutes,
    });
  } catch {
    saveError.value = true;
    saveMessage.value = '설정 불러오기 실패';
  }
}

async function save() {
  saving.value = true;
  saveError.value = false;
  saveMessage.value = '';
  try {
    await chartApi.saveConfig({ ...form.value });
    saveMessage.value = '설정 저장 완료';
    await loadConfig();
    setTimeout(() => { saveMessage.value = ''; }, 3000);
  } catch (err: any) {
    saveError.value = true;
    saveMessage.value = err.response?.data?.error || '저장 실패';
  } finally {
    saving.value = false;
  }
}

onMounted(loadConfig);
</script>
