<template>
  <div :class="darkMode ? 'dark' : ''" class="min-h-screen bg-slate-50 dark:bg-slate-950 dark:text-slate-200">
    <!-- 사이드바 -->
    <aside class="fixed top-0 left-0 w-56 h-full bg-slate-900 text-white flex flex-col z-10">
      <div class="p-5 border-b border-slate-700">
        <h1 class="text-lg font-bold tracking-tight">Stock Manager</h1>
        <p class="text-xs text-slate-400 mt-1">포트폴리오 관리</p>
      </div>
      <nav class="flex-1 p-3 space-y-1">
        <router-link
          v-for="item in menuItems"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors"
          :class="$route.path === item.path ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'"
        >
          <span class="text-lg">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </router-link>
      </nav>

      <!-- 하단 알림 + 설정 -->
      <div class="p-3 border-t border-slate-700 space-y-1">
        <button @click="toggleNotifications"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-slate-300 hover:bg-slate-800 relative">
          <span class="text-lg">🔔</span>
          <span>알림</span>
          <span v-if="unreadCount > 0"
            class="absolute right-3 top-1/2 -translate-y-1/2 bg-red-500 text-white text-xs rounded-full min-w-5 h-5 flex items-center justify-center px-1">
            {{ unreadCount > 99 ? '99+' : unreadCount }}
          </span>
        </button>
        <router-link
          to="/settings"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors"
          :class="$route.path === '/settings' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'"
        >
          <span class="text-lg">⚙️</span>
          <span>설정</span>
        </router-link>
        <button @click="toggleDarkMode"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-slate-300 hover:bg-slate-800">
          <span class="text-lg">{{ darkMode ? '☀️' : '🌙' }}</span>
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
    <main class="ml-56 p-6 dark:bg-slate-950">
      <router-view />
    </main>

    <!-- 알림 패널 -->
    <div v-if="showNotifications" class="fixed inset-0 z-40" @click="showNotifications = false">
      <div class="fixed top-0 right-0 w-96 h-full bg-white dark:bg-slate-900 shadow-2xl z-50 flex flex-col" @click.stop>
        <div class="flex items-center justify-between p-4 border-b">
          <h3 class="font-bold text-slate-800">알림</h3>
          <div class="flex gap-2">
            <button @click="markAllRead" class="text-xs text-blue-600 hover:underline">모두 읽음</button>
            <button @click="showNotifications = false" class="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="notifications.length === 0" class="text-center py-12 text-slate-400 text-sm">알림이 없습니다</div>
          <div v-for="n in notifications" :key="n.id"
            class="p-4 border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
            :class="{ 'bg-blue-50/50': !n.is_read }"
            @click="handleNotificationClick(n)">
            <div class="flex items-start gap-2">
              <span class="text-lg mt-0.5">{{ n.type === 'PROMOTION' ? '⭐' : n.type === 'AUTO_TRADE' ? '🤖' : '🔔' }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-slate-800">{{ n.title }}</p>
                <p class="text-xs text-slate-500 mt-0.5 line-clamp-2">{{ n.message }}</p>
                <p class="text-xs text-slate-400 mt-1">{{ formatNotifDate(n.created_at) }}</p>
              </div>
              <button @click.stop="deleteNotif(n.id)" class="text-slate-300 hover:text-red-400 text-xs">&times;</button>
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
    // 서버 재시작 대기 후 새로고침
    setTimeout(() => { location.reload(); }, 30000);
  } catch {
    updating.value = false;
    alert('업데이트 실패. 터미널에서 수동으로 실행하세요:\nstock-manager stop && brew upgrade stock-manager && stock-manager start');
  }
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
    notifications.value.forEach(n => n.is_read = 1);
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
    n.is_read = 1;
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
