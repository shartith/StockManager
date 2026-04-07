<template>
  <div :class="darkMode ? 'dark' : ''" class="min-h-screen bg-surface-0 text-txt-primary">
    <!-- 모바일 헤더 -->
    <header class="fixed top-0 left-0 right-0 h-14 bg-surface-1 border-b border-border flex items-center justify-between px-4 z-30 md:hidden">
      <button @click="sidebarOpen = !sidebarOpen" aria-label="메뉴 열기"
        class="p-2 rounded-lg hover:bg-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <svg class="w-5 h-5 text-txt-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
      </button>
      <h1 class="text-sm font-bold text-txt-primary tracking-tight">Stock Manager</h1>
      <div class="flex items-center gap-1">
        <ConnectionStatus :status="wsDisplayStatus" :last-update="wsLastUpdate" :interval-ms="refreshIntervalMs" />
        <button @click="toggleNotifications" aria-label="알림"
          class="p-2 rounded-lg hover:bg-surface-2 relative transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <svg class="w-5 h-5 text-txt-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
          </svg>
          <span v-if="unreadCount > 0"
            class="absolute -top-0.5 -right-0.5 bg-profit text-white text-[10px] rounded-full min-w-4 h-4 flex items-center justify-center px-1 font-medium">
            {{ unreadCount > 99 ? '99+' : unreadCount }}
          </span>
        </button>
      </div>
    </header>

    <!-- 모바일 오버레이 -->
    <Transition name="fade">
      <div v-if="sidebarOpen" class="fixed inset-0 bg-black/40 backdrop-blur-sm z-20 md:hidden" @click="sidebarOpen = false" />
    </Transition>

    <!-- 사이드바 -->
    <aside
      role="navigation"
      aria-label="메인 내비게이션"
      class="fixed top-0 left-0 h-full bg-surface-1 border-r border-border flex flex-col z-30 transition-all duration-300 ease-expo"
      :class="[
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        collapsed ? 'w-[68px]' : 'w-56'
      ]"
    >
      <!-- 로고 -->
      <div class="p-4 border-b border-border flex items-center justify-between" :class="collapsed ? 'px-3' : ''">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
            <svg class="w-5 h-5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 3v18h18" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M7 16l4-8 4 4 4-8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div v-if="!collapsed" class="min-w-0">
            <h1 class="text-sm font-bold text-txt-primary tracking-tight truncate">Stock Manager</h1>
            <p class="text-[10px] text-txt-tertiary">포트폴리오 관리</p>
          </div>
        </div>
        <button v-if="!collapsed" @click="collapsed = true" aria-label="사이드바 접기"
          class="hidden md:flex p-1 rounded hover:bg-surface-2 text-txt-tertiary hover:text-txt-secondary transition-colors">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>

      <!-- 네비게이션 -->
      <nav class="flex-1 p-2 space-y-0.5 overflow-y-auto" aria-label="주 메뉴">
        <router-link
          v-for="item in menuItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :class="{ active: $route.path === item.path }"
          :aria-current="$route.path === item.path ? 'page' : undefined"
          :title="collapsed ? item.label : undefined"
          @click="sidebarOpen = false"
        >
          <component :is="item.icon" class="w-5 h-5 shrink-0" />
          <span v-if="!collapsed" class="truncate">{{ item.label }}</span>
        </router-link>
      </nav>

      <!-- 하단 -->
      <div class="p-2 border-t border-border space-y-0.5">
        <!-- 축소 모드에서 확장 버튼 -->
        <button v-if="collapsed" @click="collapsed = false" aria-label="사이드바 펼치기"
          class="nav-item w-full justify-center">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M13 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        <!-- 알림 -->
        <button @click="toggleNotifications" aria-label="알림 패널 열기"
          class="nav-item w-full relative" :title="collapsed ? '알림' : undefined">
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
          </svg>
          <span v-if="!collapsed">알림</span>
          <span v-if="unreadCount > 0"
            class="absolute bg-profit text-white text-[10px] rounded-full min-w-4 h-4 flex items-center justify-center px-1 font-medium"
            :class="collapsed ? 'top-0 right-0' : 'right-2 top-1/2 -translate-y-1/2'"
            :aria-label="`읽지 않은 알림 ${unreadCount}개`">
            {{ unreadCount > 99 ? '99+' : unreadCount }}
          </span>
        </button>

        <!-- 설정 -->
        <router-link
          to="/settings"
          class="nav-item"
          :class="{ active: $route.path === '/settings' }"
          :aria-current="$route.path === '/settings' ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
          <span v-if="!collapsed">설정</span>
        </router-link>

        <!-- 다크모드 -->
        <button @click="toggleDarkMode"
          :aria-label="darkMode ? '라이트 모드로 전환' : '다크 모드로 전환'"
          class="nav-item w-full" :title="collapsed ? (darkMode ? '라이트 모드' : '다크 모드') : undefined">
          <svg v-if="darkMode" class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
          </svg>
          <svg v-else class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
          </svg>
          <span v-if="!collapsed">{{ darkMode ? '라이트 모드' : '다크 모드' }}</span>
        </button>

        <!-- 연결 상태 + 버전 -->
        <div class="flex items-center gap-1 px-2 py-1.5">
          <ConnectionStatus :status="wsDisplayStatus" :last-update="wsLastUpdate" :interval-ms="refreshIntervalMs" />
          <span v-if="!collapsed" class="text-[10px] text-txt-tertiary ml-auto">
            v{{ versionInfo.currentVersion }}
          </span>
        </div>
        <button v-if="versionInfo.updateAvailable && !collapsed" @click="runUpdate" :disabled="updating"
          class="w-full px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50 transition-colors">
          {{ updating ? '업데이트 중...' : `v${versionInfo.latestVersion} 업데이트` }}
        </button>
      </div>
    </aside>

    <!-- 메인 콘텐츠 -->
    <main role="main"
      class="pt-14 md:pt-0 min-h-screen transition-[margin] duration-300 ease-expo"
      :class="collapsed ? 'md:ml-[68px]' : 'md:ml-56'"
    >
      <div class="p-4 md:p-6 max-w-[1600px] mx-auto">
        <router-view v-slot="{ Component }">
          <Transition name="page-fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </router-view>
      </div>
    </main>

    <!-- 알림 패널 -->
    <Transition name="fade">
      <div v-if="showNotifications" class="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="알림 패널" @click="showNotifications = false" @keydown.escape="showNotifications = false">
        <div class="fixed top-0 right-0 w-full sm:w-96 h-full bg-surface-1 border-l border-border shadow-lg z-50 flex flex-col" @click.stop>
          <div class="flex items-center justify-between p-4 border-b border-border">
            <h3 class="font-bold text-txt-primary">알림</h3>
            <div class="flex items-center gap-3">
              <button @click="markAllRead"
                class="text-xs text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded">모두 읽음</button>
              <button @click="deleteAllNotifs" :disabled="notifications.length === 0"
                class="text-xs text-profit hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-profit rounded disabled:opacity-40 disabled:cursor-not-allowed">모두 삭제</button>
              <button @click="showNotifications = false" aria-label="알림 패널 닫기"
                class="text-txt-tertiary hover:text-txt-primary text-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded p-1">&times;</button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto">
            <div v-if="notifications.length === 0" class="text-center py-12 text-txt-tertiary text-sm">
              알림이 없습니다
            </div>
            <div v-for="n in notifications" :key="n.id"
              class="p-4 border-b border-border-subtle hover:bg-surface-2 cursor-pointer transition-colors"
              :class="{ 'bg-accent-dim': !n.is_read }"
              role="button"
              tabindex="0"
              @click="handleNotificationClick(n)"
              @keydown.enter="handleNotificationClick(n)">
              <div class="flex items-start gap-3">
                <span class="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
                  :class="n.type === 'AUTO_TRADE' ? 'bg-profit/10 text-profit' : n.type === 'PROMOTION' ? 'bg-gold-dim text-gold' : 'bg-accent-dim text-accent'">
                  {{ n.type === 'PROMOTION' ? '&#9733;' : n.type === 'AUTO_TRADE' ? '&#9670;' : '&#9679;' }}
                </span>
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-txt-primary">{{ n.title }}</p>
                  <p class="text-xs text-txt-secondary mt-0.5 line-clamp-2">{{ n.message }}</p>
                  <p class="text-xs text-txt-tertiary mt-1">{{ formatNotifDate(n.created_at) }}</p>
                </div>
                <button @click.stop="deleteNotif(n.id)" aria-label="알림 삭제"
                  class="text-txt-tertiary hover:text-profit text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded p-1">&times;</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 토스트 알림 -->
    <ToastNotification ref="toastRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, h } from 'vue';
import { useRouter } from 'vue-router';
import { notificationsApi, versionApi, setGlobalErrorReporter } from '@/api';
import { useWebSocket } from '@/composables/useWebSocket';
import { getRefreshInterval } from '@/composables/useAutoRefresh';
import ConnectionStatus from '@/components/ConnectionStatus.vue';
import ToastNotification from '@/components/ToastNotification.vue';

// ── Icons as render functions ──
const IconDashboard = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' })
])};
const IconSearch = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' })
])};
const IconStar = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z' })
])};
const IconChart = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z' })
])};
const IconList = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' })
])};
const IconBriefcase = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' })
])};
const IconTrending = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' })
])};
const IconCoin = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' })
])};
const IconBell = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '2', d: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9' })
])};
const IconHeatmap = { render: () => h('svg', { class: 'w-5 h-5', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' }, [
  h('rect', { x: '3', y: '3', width: '7', height: '7', rx: '1', 'stroke-width': '2' }),
  h('rect', { x: '14', y: '3', width: '7', height: '4', rx: '1', 'stroke-width': '2' }),
  h('rect', { x: '14', y: '10', width: '7', height: '11', rx: '1', 'stroke-width': '2' }),
  h('rect', { x: '3', y: '14', width: '7', height: '7', rx: '1', 'stroke-width': '2' }),
])};

const router = useRouter();
const showNotifications = ref(false);
const sidebarOpen = ref(false);
const collapsed = ref(false);

// WebSocket
const { status: wsStatus, lastUpdate: wsLastUpdate, on: wsOn } = useWebSocket();
const wsDisplayStatus = computed(() => {
  if (wsStatus.value === 'connected') return 'connected' as const;
  if (wsStatus.value === 'reconnecting') return 'polling' as const;
  return 'disconnected' as const;
});
const refreshIntervalMs = computed(() => getRefreshInterval());

// 버전 + 업데이트
const versionInfo = ref({ currentVersion: '-', latestVersion: '-', updateAvailable: false });
const updating = ref(false);

async function checkVersion() {
  try {
    const { data } = await versionApi.check();
    versionInfo.value = data;
  } catch {}
}

async function runUpdate() {
  if (!confirm('Stock Manager를 최신 버전으로 업데이트합니다.\n서버가 재시작되며 약 1~2분 소요됩니다.\n계속하시겠습니까?')) return;
  updating.value = true;
  try {
    await versionApi.update();
  } catch {}

  const pollRestart = () => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          clearInterval(interval);
          location.reload();
        }
      } catch {}
    }, 5000);
    setTimeout(() => {
      clearInterval(interval);
      updating.value = false;
      alert('서버 재시작 대기 시간 초과.\n터미널에서 확인하세요: stock-manager status');
    }, 180000);
  };
  setTimeout(pollRestart, 10000);
}

// 다크모드
const darkMode = ref(localStorage.getItem('darkMode') !== 'false'); // Default dark
function toggleDarkMode() {
  darkMode.value = !darkMode.value;
  localStorage.setItem('darkMode', String(darkMode.value));
}

const unreadCount = ref(0);
const notifications = ref<any[]>([]);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const menuItems = [
  { path: '/', label: '대시보드', icon: IconDashboard },
  { path: '/heatmap', label: '시장 히트맵', icon: IconHeatmap },
  { path: '/recommendations', label: '추천 종목', icon: IconSearch },
  { path: '/watchlist', label: '관심 종목', icon: IconStar },
  { path: '/chart', label: '주식 차트', icon: IconChart },
  { path: '/transactions', label: '거래 내역', icon: IconList },
  { path: '/portfolio', label: '포트폴리오', icon: IconBriefcase },
  { path: '/feedback', label: '성과 분석', icon: IconTrending },
  { path: '/dividends', label: '배당금', icon: IconCoin },
  { path: '/alerts', label: '알림 설정', icon: IconBell },
];

// Toast
const toastRef = ref<InstanceType<typeof ToastNotification> | null>(null);
provide('toast', toastRef);

// v4.7.0: route global API errors through the toast singleton.
// Components can opt out per-request via { suppressGlobalToast: true }.
setGlobalErrorReporter((message: string) => {
  toastRef.value?.show({ type: 'error', message });
});

// WebSocket notification listener
wsOn('notifications', (data: unknown) => {
  const n = data as { title?: string; message?: string; type?: string };
  if (toastRef.value && n.message) {
    toastRef.value.show({
      type: n.type === 'AUTO_TRADE' ? 'trade' : 'info',
      title: n.title,
      message: n.message,
    });
  }
  fetchUnreadCount();
});

async function fetchUnreadCount() {
  try {
    const { data } = await notificationsApi.getUnreadCount();
    unreadCount.value = data.count;
  } catch {}
}

async function fetchNotifications() {
  try {
    const { data } = await notificationsApi.getAll();
    notifications.value = data.notifications;
    unreadCount.value = data.unreadCount;
  } catch {}
}

async function toggleNotifications() {
  showNotifications.value = !showNotifications.value;
  if (showNotifications.value) await fetchNotifications();
}

async function markAllRead() {
  try {
    await notificationsApi.markAllAsRead();
    unreadCount.value = 0;
    notifications.value = notifications.value.map(n => ({ ...n, is_read: 1 }));
  } catch {}
}

async function deleteNotif(id: number) {
  try {
    await notificationsApi.delete(id);
    notifications.value = notifications.value.filter(n => n.id !== id);
    await fetchUnreadCount();
  } catch {}
}

async function deleteAllNotifs() {
  if (notifications.value.length === 0) return;
  if (!confirm(`알림 ${notifications.value.length}건을 모두 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await notificationsApi.deleteAll();
    notifications.value = [];
    unreadCount.value = 0;
  } catch {}
}

function handleNotificationClick(n: any) {
  if (!n.is_read) {
    notificationsApi.markAsRead(n.id);
    notifications.value = notifications.value.map(item =>
      item.id === n.id ? { ...item, is_read: 1 } : item
    );
    unreadCount.value = Math.max(0, unreadCount.value - 1);
  }
  if (n.action_url) {
    showNotifications.value = false;
    router.push(n.action_url);
  }
}

function formatNotifDate(dt: string) {
  const d = new Date(dt.includes('Z') ? dt : dt + 'Z');
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

onMounted(() => {
  fetchUnreadCount();
  checkVersion();
  pollTimer = setInterval(fetchUnreadCount, 60000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
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
