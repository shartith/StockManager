import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';

export type WsChannel = 'portfolio' | 'prices' | 'market' | 'notifications' | 'signals' | 'system';

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<WsChannel>;
  lastPing: number;
}

interface WsBroadcastMessage {
  channel: WsChannel;
  type: 'update' | 'snapshot';
  data: unknown;
  timestamp: string;
}

const HEARTBEAT_INTERVAL = 30_000;
const CLIENT_TIMEOUT = 90_000;
const VALID_CHANNELS = new Set<string>(['portfolio', 'prices', 'market', 'notifications', 'signals', 'system', 'heatmap']);

let wss: WebSocketServer | null = null;
const clients = new Set<WsClient>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } = console;

export function setWsLogger(l: typeof logger) {
  logger = l;
}

export function initWebSocket(
  server: HttpServer,
  tokenValidator: (token: string) => boolean,
): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', `http://localhost`);
    const token = url.searchParams.get('token');

    if (!token || !tokenValidator(token)) {
      logger.warn('WebSocket connection rejected: invalid or expired token');
      ws.close(4401, 'Unauthorized');
      return;
    }

    const client: WsClient = {
      ws,
      subscriptions: new Set(['portfolio', 'prices', 'notifications']),
      lastPing: Date.now(),
    };

    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'ping') {
          client.lastPing = Date.now();
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
          for (const ch of msg.channels) {
            if (VALID_CHANNELS.has(ch) && client.subscriptions.size < 20) {
              client.subscriptions.add(ch as WsChannel);
            }
          }
          return;
        }

        if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
          for (const ch of msg.channels) {
            if (VALID_CHANNELS.has(ch)) {
              client.subscriptions.delete(ch as WsChannel);
            }
          }
          return;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(client);
    });

    ws.on('error', () => {
      clients.delete(client);
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Stock Manager WebSocket' }));
  });

  // Heartbeat: close stale clients
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (now - client.lastPing > CLIENT_TIMEOUT) {
        client.ws.terminate();
        clients.delete(client);
      }
    }
  }, HEARTBEAT_INTERVAL);

  return wss;
}

/**
 * Broadcast a message to all connected clients subscribed to the given channel.
 */
export function broadcast(channel: WsChannel, data: unknown): void {
  const msg: WsBroadcastMessage = {
    channel,
    type: 'update',
    data,
    timestamp: new Date().toISOString(),
  };
  const raw = JSON.stringify(msg);

  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN && client.subscriptions.has(channel)) {
      client.ws.send(raw);
    }
  }
}

/**
 * Broadcast raw data to ALL clients (backward compat with legacy __wsBroadcast).
 */
export function broadcastRaw(data: unknown): void {
  const raw = JSON.stringify(data);
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(raw);
    }
  }
}

/**
 * Get count of connected clients.
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Close all clients and clean up.
 */
export function closeAll(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    for (const client of clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    clients.clear();
    logger.info('WebSocket clients closed');

    if (wss) {
      wss.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    } else {
      resolve();
    }
  });
}
