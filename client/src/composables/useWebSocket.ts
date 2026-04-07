import { ref, readonly, onUnmounted } from 'vue';

export type WsStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface WsMessage {
  channel: string;
  type: 'update' | 'snapshot' | 'connected';
  data: unknown;
  timestamp?: string;
}

type Handler = (data: unknown) => void;

const MAX_RETRIES = 20;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const HEARTBEAT_INTERVAL = 30000;

// Singleton state shared across components
const status = ref<WsStatus>('disconnected');
const lastUpdate = ref<Date | null>(null);
const handlers = new Map<string, Set<Handler>>();
let ws: WebSocket | null = null;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let visibilityHandler: (() => void) | null = null;

function getWsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

function backoff(attempt: number): number {
  const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);
  // Add jitter +-25%
  return delay * (0.75 + Math.random() * 0.5);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  try {
    ws = new WebSocket(getWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    status.value = 'connected';
    retryCount = 0;
    startHeartbeat();

    // Subscribe to all registered channels
    const channels = Array.from(handlers.keys());
    if (channels.length > 0) {
      ws?.send(JSON.stringify({ type: 'subscribe', channels }));
    }
  };

  ws.onclose = () => {
    status.value = retryCount > 0 ? 'reconnecting' : 'disconnected';
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };

  ws.onmessage = (event) => {
    try {
      const msg: WsMessage = JSON.parse(event.data);

      if (msg.type === 'connected') return;
      if ((msg as unknown as { type: string }).type === 'pong') return;

      lastUpdate.value = new Date();

      const channel = msg.channel;
      if (channel && handlers.has(channel)) {
        handlers.get(channel)!.forEach(fn => fn(msg.data));
      }

      // Also fire wildcard handlers
      if (handlers.has('*')) {
        handlers.get('*')!.forEach(fn => fn(msg));
      }
    } catch {
      // Ignore malformed messages
    }
  };
}

function scheduleReconnect() {
  if (retryTimer) return;
  if (retryCount >= MAX_RETRIES) {
    status.value = 'disconnected';
    return;
  }

  const delay = backoff(retryCount);
  retryCount++;
  status.value = 'reconnecting';

  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function disconnect() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  stopHeartbeat();
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  status.value = 'disconnected';
  retryCount = 0;
  initialized = false;
}

export function useWebSocket() {
  if (!initialized) {
    initialized = true;
    connect();

    visibilityHandler = () => {
      if (!document.hidden && status.value !== 'connected') {
        retryCount = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  function subscribe(channel: string, handler: Handler) {
    if (!handlers.has(channel)) {
      handlers.set(channel, new Set());
    }
    handlers.get(channel)!.add(handler);

    // If connected, send subscription message
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channels: [channel] }));
    }
  }

  function unsubscribe(channel: string, handler: Handler) {
    const set = handlers.get(channel);
    if (set) {
      set.delete(handler);
      if (set.size === 0) handlers.delete(channel);
    }
  }

  // Auto-cleanup on component unmount
  const localHandlers: Array<{ channel: string; handler: Handler }> = [];

  function on(channel: string, handler: Handler) {
    subscribe(channel, handler);
    localHandlers.push({ channel, handler });
  }

  onUnmounted(() => {
    for (const { channel, handler } of localHandlers) {
      unsubscribe(channel, handler);
    }
  });

  return {
    status: readonly(status),
    lastUpdate: readonly(lastUpdate),
    on,
    subscribe,
    unsubscribe,
    connect,
    disconnect,
  };
}
