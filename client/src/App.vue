<template>
  <div :class="darkMode ? 'dark' : ''" class="min-h-screen bg-slate-50 dark:bg-slate-950 dark:text-slate-200">
    <!-- 모바일 헤더 -->
    <header class="fixed top-0 left-0 right-0 h-14 bg-slate-900 text-white flex items-center justify-between px-4 z-30 md:hidden">
      <button @click="sidebarOpen = !sidebarOpen" aria-label="메뉴 열기" class="p-2 rounded-lg hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <h1 class="text-sm font-bold">Stock Manager</h1>
      <button @click="toggleNotifications" aria-label="알림" class="p-2 rounded-lg hover:bg-slate-800 relative focus:outline-none focus:ring-2 focus:ring-blue-500">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
        <span v-if="unreadCount > 0" class="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] rounded-full min-w-4 h-4 flex items-center justify-center px-1">
          {{ unreadCount > 99 ? '99+' : unreadCount }}
        </span>
      </button>
    </header>

    <!-- 모바일 오버레이 -->
    <div v-if="sidebarOpen" class="fixed inset-0 bg-black/50 z-20 md:hidden" @click="sidebarOpen = false" />

    <!-- 사이드바 -->
    <aside
      role="navigation"
      aria-label="메인 내비게이션"
      class="fixed top-0 left-0 w-56 h-full bg-slate-900 text-white flex flex-col z-30 transition-transform duration-200 ease-out"
      :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'"
    >
      <div class="p-5 border-b border-slate-700">
        <h1 class="text-lg font-bold tracking-tight">Stock Manager</h1>
        <p class="text-xs text-slate-400 mt-1">포트폴리오 관리</p>
      </div>
      <nav class="flex-1 p-3 space-y-1" aria-label="주 메뉴">
        <router-link
          v-for="item in menuItems"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          :class="$route.path === item.path ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'"
          :aria-current="$route.path === item.path ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <span class="text-lg" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </router-link>
      </nav>

      <!-- 하단 알림 + 설정 -->
      <div class="p-3 border-t border-slate-700 space-y-1">
        <button @click="toggleNotifications" aria-label="알림 패널 열기"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-slate-300 hover:bg-slate-800 relative focus:outline-none focus:ring-2 focus:ring-blue-500">
          <span class="text-lg" aria-hidden="true">🔔</span>
          <span>알림</span>
          <span v-if="unreadCount > 0"
            class="absolute right-3 top-1/2 -translate-y-1/2 bg-red-500 text-white text-xs rounded-full min-w-5 h-5 flex items-center justify-center px-1"
            :aria-label="`읽지 않은 알림 ${unreadCount}개`">
            {{ unreadCount > 99 ? '99+' : unreadCount }}
          </span>
        </button>
        <router-link
          to="/settings"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          :class="$route.path === '/settings' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'"
          :aria-current="$route.path === '/settings' ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <span class="text-lg" aria-hidden="true">⚙️</span>
          <span>설정</span>
        </router-link>
        <button @click="toggleDarkMode" :aria-label="darkMode ? '라이트 모드로 전환' : '다크 모드로 전환'"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-slate-300 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <span class="text-lg" aria-hidden="true">{{ darkMode ? '☀️' : '🌙' }}</span>
          <span>{{ darkMode ? '라이트 모드' : '다크 모드' }}</span>
        </button>
        <!-- 버전 + 업데이트 -->
        <div class="px-3 py-2 text-xs text-slate-500">
          <span>v{{ versionInfo.currentVersion }}</span>
          <button v-if="versionInfo.updateAvailable" @click="runUpdate" :disabled="updating"
            class="ml-2 px-2 py-0.5 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-50">
            {{ updating ? '업데이트 중...' : `v${versionInfo.latestVersion} 업데이트` }}
          </button>
        </div>
      </div>
    </aside>

    <!-- 메인 콘텐츠 -->
    <main role="main" class="pt-14 md:pt-0 md:ml-56 p-4 md:p-6 dark:bg-slate-950 min-h-screen">
      <router-view />
    </main>

    <!-- 알림 패널 -->
    <div v-if="showNotifications" class="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="알림 패널" @click="showNotifications = false" @keydown.escape="showNotifications = false">
      <div class="fixed top-0 right-0 w-full sm:w-96 h-full bg-white dark:bg-slate-900 shadow-2xl z-50 flex flex-col" @click.stop>
        <div class="flex items-center justify-between p-4 border-b dark:border-slate-700">
          <h3 class="font-bold text-slate-800 dark:text-slate-200">알림</h3>
          <div class="flex gap-2">
            <button @click="markAllRead" class="text-xs text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded">모두 읽음</button>
            <button @click="showNotifications = false" aria-label="알림 패널 닫기" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 rounded">&times;</button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="notifications.length === 0" class="text-center py-12 text-slate-400 text-sm">알림이 없습니다</div>
          <div v-for="n in notifications" :key="n.id"
            class="p-4 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            :class="{ 'bg-blue-50/50 dark:bg-blue-900/20': !n.is_read }"
            role="button"
            tabindex="0"
            @click="handleNotificationClick(n)"
            @keydown.enter="handleNotificationClick(n)">
            <div class="flex items-start gap-2">
              <span class="text-lg mt-0.5" aria-hidden="true">{{ n.type === 'PROMOTION' ? '⭐' : n.type === 'AUTO_TRADE' ? '🤖' : '🔔' }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-slate-800 dark:text-slate-200">{{ n.title }}</p>
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{{ n.message }}</p>
                <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">{{ formatNotifDate(n.created_at) }}</p>
              </div>
              <button @click.stop="deleteNotif(n.id)" aria-label="알림 삭제" class="text-slate-300 hover:text-red-400 text-xs focus:outline-none focus:ring-2 focus:ring-red-500 rounded">&times;</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { notificationsApi, versionApi } from '@/api';

const router = useRouter();
const showNotifications = ref(false);
const sidebarOpen = ref(false);

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

  // 서버가 다시 올라올 때까지 5초 간격 polling
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
    // 3분 후 타임아웃
    setTimeout(() => {
      clearInterval(interval);
      updating.value = false;
      alert('서버 재시작 대기 시간 초과.\n터미널에서 확인하세요: stock-manager status');
    }, 180000);
  };
  // 10초 후 polling 시작 (brew upgrade 시간 확보)
  setTimeout(pollRestart, 10000);
}

// 다크모드
const darkMode = ref(localStorage.getItem('darkMode') === 'true');
function toggleDarkMode() {
  darkMode.value = !darkMode.value;
  localStorage.setItem('darkMode', String(darkMode.value));
}
const unreadCount = ref(0);
const notifications = ref<any[]>([]);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const menuItems = [
  { path: '/', label: '대시보드', icon: '📊' },
  { path: '/recommendations', label: '추천 종목', icon: '🔍' },
  { path: '/watchlist', label: '관심 종목', icon: '⭐' },
  { path: '/chart', label: '주식 차트', icon: '📈' },
  { path: '/transactions', label: '거래 내역', icon: '📝' },
  { path: '/portfolio', label: '포트폴리오', icon: '💼' },
  { path: '/feedback', label: '성과 분석', icon: '📉' },
  { path: '/dividends', label: '배당금', icon: '💰' },
  { path: '/alerts', label: '알림 설정', icon: '🔔' },
];

async function fetchUnreadCount() {
  try {
    const { data } = await notificationsApi.getUnreadCount();
    unreadCount.value = data.count;
  } catch { /* */ }
}

async function fetchNotifications() {
  try {
    const { data } = await notificationsApi.getAll();
    notifications.value = data.notifications;
    unreadCount.value = data.unreadCount;
  } catch { /* */ }
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
  } catch { /* */ }
}

async function deleteNotif(id: number) {
  try {
    await notificationsApi.delete(id);
    notifications.value = notifications.value.filter(n => n.id !== id);
    await fetchUnreadCount();
  } catch { /* */ }
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
