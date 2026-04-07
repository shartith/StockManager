import { ref, readonly, watch, onMounted, onUnmounted } from 'vue';
import { useWebSocket, type WsStatus } from './useWebSocket';

const STORAGE_KEY = 'stockmanager_refresh_interval';
const DEFAULT_INTERVAL = 30000; // 30 seconds

// Shared settings across components
const refreshInterval = ref<number>(
  parseInt(localStorage.getItem(STORAGE_KEY) || String(DEFAULT_INTERVAL), 10)
);

export function setRefreshInterval(ms: number) {
  refreshInterval.value = ms;
  localStorage.setItem(STORAGE_KEY, String(ms));
}

export function getRefreshInterval(): number {
  return refreshInterval.value;
}

export function useAutoRefresh(
  fetchFn: () => Promise<void>,
  options: {
    /** WebSocket channel to subscribe to — if provided, WS updates trigger fetchFn */
    wsChannel?: string;
    /** Override the global interval for this specific use */
    intervalOverride?: number;
    /** Whether to fetch immediately on mount */
    immediate?: boolean;
  } = {}
) {
  const { status, lastUpdate, on } = useWebSocket();
  const loading = ref(false);
  const lastRefresh = ref<Date | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let mounted = true;

  async function refresh() {
    if (loading.value || !mounted) return;
    loading.value = true;
    try {
      await fetchFn();
      lastRefresh.value = new Date();
    } catch {
      // Caller handles errors
    } finally {
      loading.value = false;
    }
  }

  function startPolling() {
    stopPolling();
    const interval = options.intervalOverride ?? refreshInterval.value;
    if (interval <= 0) return; // Manual mode

    pollTimer = setInterval(refresh, interval);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Subscribe to WS channel for push updates
  if (options.wsChannel) {
    on(options.wsChannel, () => {
      refresh();
    });
  }

  // Smart polling: only poll when WS is not connected
  watch(status, (val: WsStatus) => {
    if (options.wsChannel) {
      if (val === 'connected') {
        stopPolling();
      } else {
        startPolling();
      }
    }
  });

  // Pause polling when tab is hidden, refresh when visible again
  function onVisibility() {
    if (document.hidden) {
      stopPolling();
    } else {
      // Refresh immediately on tab focus
      refresh();
      // Restart polling if WS is not connected
      if (!options.wsChannel || status.value !== 'connected') {
        startPolling();
      }
    }
  }

  // Watch for global interval changes
  watch(refreshInterval, () => {
    if (!options.wsChannel || status.value !== 'connected') {
      startPolling();
    }
  });

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility);

    if (options.immediate !== false) {
      refresh();
    }

    // Start polling if no WS channel or WS not connected
    if (!options.wsChannel || status.value !== 'connected') {
      startPolling();
    }
  });

  onUnmounted(() => {
    mounted = false;
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibility);
  });

  return {
    loading: readonly(loading),
    lastRefresh: readonly(lastRefresh),
    wsStatus: status,
    wsLastUpdate: lastUpdate,
    refreshInterval: readonly(refreshInterval),
    refresh,
    setRefreshInterval,
  };
}
