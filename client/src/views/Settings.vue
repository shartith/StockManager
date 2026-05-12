<template>
  <div class="space-y-6">
    <div>
      <h2 class="text-2xl font-bold text-txt-primary">설정</h2>
      <p class="text-sm text-txt-tertiary mt-0.5">v5.6.0 — Top 10 시총 추종 (라이트 모드)</p>
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

    <!-- 자동매매 -->
    <div class="solid-card p-5 space-y-3">
      <h3 class="text-sm font-semibold text-txt-primary">자동매매</h3>
      <ToggleSwitch v-model="form.autoTradeEnabled" label="자동매매 활성" />
      <ToggleSwitch v-model="scheduleEnabled" label="KRX 스케줄 활성 (09:00 + 매시 10~14시 rebalance)" />
      <p class="text-xs text-txt-tertiary">
        매일 09:00에 시총 Top 10 추종 rebalance (이탈 매도 + 신규 진입). 매시 10~14시에 시총 재산정 후 변경분 적용.
      </p>
    </div>

    <!-- 시장 브레이크 -->
    <div class="solid-card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-txt-primary">시장 브레이크 (안전망)</h3>
        <ToggleSwitch v-model="form.marketBrakeEnabled" />
      </div>
      <p class="text-xs text-txt-tertiary">
        KOSPI 또는 VIX 가 임계값을 넘으면 신규 매수 차단 (이탈 매도는 항상 진행).
      </p>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">KOSPI 하락 임계값 (%)</label>
          <input v-model.number="form.marketBrakeKospiPercent" type="number" step="0.1" min="0.5" max="10"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div>
          <label class="block text-xs font-medium text-txt-secondary mb-1">VIX 상승 임계값</label>
          <input v-model.number="form.marketBrakeVixLevel" type="number" step="1" min="15" max="80"
            class="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
      </div>
    </div>

    <!-- 저장 -->
    <div class="sticky bottom-4 z-10">
      <button @click="save" :disabled="saving"
        class="w-full md:w-auto md:float-right px-6 py-3 bg-accent text-white rounded-lg font-medium hover:bg-accent/90 disabled:opacity-50 shadow-lg">
        {{ saving ? '저장 중…' : '💾 설정 저장' }}
      </button>
    </div>

    <!-- 알림 -->
    <Transition name="fade">
      <div v-if="message" class="fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg"
        :class="messageType === 'error' ? 'bg-loss text-white' : 'bg-profit text-white'">
        {{ message }}
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, inject } from 'vue';
import axios from 'axios';
import ToggleSwitch from '@/components/ToggleSwitch.vue';

interface AutoRefreshInjector { setIntervalMs: (n: number) => void }
const autoRefresh = inject<AutoRefreshInjector | null>('autoRefresh', null);

const refreshOptions = [
  { value: 10000, label: '10초' },
  { value: 30000, label: '30초' },
  { value: 60000, label: '1분 (기본)' },
  { value: 180000, label: '3분' },
  { value: 600000, label: '10분' },
];
const refreshInterval = ref<number>(Number(localStorage.getItem('refreshIntervalMs') ?? 60000));

function onRefreshIntervalChange(): void {
  localStorage.setItem('refreshIntervalMs', String(refreshInterval.value));
  autoRefresh?.setIntervalMs(refreshInterval.value);
}

const form = ref({
  appKey: '',
  appSecret: '',
  accountNo: '',
  accountProductCode: '01',
  isVirtual: true,
  hasSecret: false,

  autoTradeEnabled: false,

  marketBrakeEnabled: true,
  marketBrakeKospiPercent: 2.0,
  marketBrakeVixLevel: 30,
});

const scheduleEnabled = ref(false);

const saving = ref(false);
const message = ref('');
const messageType = ref<'success' | 'error'>('success');

async function load(): Promise<void> {
  try {
    const { data } = await axios.get('/api/chart/config/form');
    form.value.appKey = data.appKey || '';
    form.value.accountNo = data.accountNo || '';
    form.value.accountProductCode = data.accountProductCode || '01';
    form.value.isVirtual = data.isVirtual !== false;
    form.value.hasSecret = !!data.hasSecret;

    form.value.autoTradeEnabled = !!data.autoTradeEnabled;
    scheduleEnabled.value = !!(data.scheduleKrx?.enabled);

    form.value.marketBrakeEnabled = data.marketBrakeEnabled !== false;
    form.value.marketBrakeKospiPercent = data.marketBrakeKospiPercent ?? 2.0;
    form.value.marketBrakeVixLevel = data.marketBrakeVixLevel ?? 30;
  } catch {
    /* form은 기본값 유지 */
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    await axios.post('/api/chart/config', {
      appKey: form.value.appKey,
      appSecret: form.value.appSecret || undefined,
      accountNo: form.value.accountNo,
      accountProductCode: form.value.accountProductCode,
      isVirtual: form.value.isVirtual,

      autoTradeEnabled: form.value.autoTradeEnabled,
      scheduleKrx: { enabled: scheduleEnabled.value },

      marketBrakeEnabled: form.value.marketBrakeEnabled,
      marketBrakeKospiPercent: form.value.marketBrakeKospiPercent,
      marketBrakeVixLevel: form.value.marketBrakeVixLevel,
    });
    message.value = '✓ 설정 저장됨';
    messageType.value = 'success';
    form.value.appSecret = '';
    await load();
  } catch (err: any) {
    message.value = err.response?.data?.error || '저장 실패';
    messageType.value = 'error';
  }
  saving.value = false;
  setTimeout(() => { message.value = ''; }, 3000);
}

onMounted(() => {
  void load();
});
</script>
