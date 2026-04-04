import express from 'express';
import cors from 'cors';
import path from 'path';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { initializeDB, saveDB, queryOne } from './db';
import logger from './logger';
import { errorHandler } from './middleware/errorHandler';
import { API_RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_MAX, WS_TOKEN_TTL_MS } from './config/constants';
import stocksRouter from './routes/stocks';
import transactionsRouter from './routes/transactions';
import portfolioRouter from './routes/portfolio';
import dividendsRouter from './routes/dividends';
import alertsRouter from './routes/alerts';
import chartRouter from './routes/chart';
import analysisRouter from './routes/analysis';
import recommendationsRouter from './routes/recommendations';
import watchlistRouter from './routes/watchlist';
import notificationsRouter from './routes/notifications';
import feedbackRouter from './routes/feedback';
import tradingRulesRouter from './routes/tradingRules';
import nasSyncRouter from './routes/nasSync';
import { getSettings } from './services/settings';
import { startScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler';
import { getRecentEvents, getUnresolvedEvents, getEventCounts, resolveEvent } from './services/systemEvent';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security: Helmet ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", `ws://localhost:${PORT}`, `wss://localhost:${PORT}`, 'ws://localhost:5173', 'wss://localhost:5173'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// ── Security: CORS restricted to localhost ──
app.use(cors({
  origin: [
    `http://localhost:${PORT}`,
    'http://localhost:5173',
  ],
  credentials: true,
}));

// ── Compression ──
app.use(compression());

// ── Rate limiting on /api ──
const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});
app.use('/api', apiLimiter);

// ── Body parsing ──
app.use(express.json());

// ── WebSocket token store (one-time nonces) ──
const wsTokens = new Map<string, number>();

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, expires] of wsTokens) {
    if (now > expires) {
      wsTokens.delete(token);
    }
  }
}

// ── Routes ──
app.use('/api/stocks', stocksRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/dividends', dividendsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/chart', chartRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/recommendations', recommendationsRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/trading-rules', tradingRulesRouter);
app.use('/api/nas-sync', nasSyncRouter);

// ── WS token endpoint ──
app.get('/api/ws-token', (_req, res) => {
  cleanExpiredTokens();
  const token = crypto.randomBytes(16).toString('hex');
  wsTokens.set(token, Date.now() + WS_TOKEN_TTL_MS);
  res.json({ token });
});

// ── Enhanced health check ──
app.get('/api/health', async (_req, res) => {
  const checks: Record<string, string> = {};

  // DB check
  try {
    queryOne('SELECT 1 AS ok');
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  // Ollama check
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const ollamaRes = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    checks.ollama = ollamaRes.ok ? 'ok' : 'error';
  } catch {
    checks.ollama = 'unreachable';
  }

  // Scheduler check
  const schedulerStatus = getSchedulerStatus();
  checks.scheduler = schedulerStatus.active ? 'running' : 'stopped';

  const allOk = checks.database === 'ok';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ── Version + update check ──
const currentVersion = require(path.join(__dirname, '../../package.json')).version;

app.get('/api/version', async (_req, res) => {
  let latestVersion = currentVersion;
  let updateAvailable = false;
  try {
    const response = await fetch('https://api.github.com/repos/shartith/StockManager/releases/latest', {
      headers: { 'User-Agent': 'StockManager' },
    });
    if (response.ok) {
      const data: any = await response.json();
      latestVersion = (data.tag_name || '').replace(/^v/, '');
      updateAvailable = latestVersion !== currentVersion && latestVersion > currentVersion;
    }
  } catch (err: unknown) {
    logger.warn({ err }, 'Failed to check for updates');
  }
  res.json({ currentVersion, latestVersion, updateAvailable });
});

// ── Update execution (brew upgrade + auto restart) ──
// Requires a one-time token for authentication (same pattern as WS tokens)
const updateTokens = new Map<string, number>();

app.get('/api/update-token', (_req, res) => {
  cleanExpiredTokens();
  const token = crypto.randomBytes(16).toString('hex');
  updateTokens.set(token, Date.now() + WS_TOKEN_TTL_MS);
  res.json({ token });
});

app.post('/api/update', (req, res) => {
  // Validate one-time update token
  const authToken = req.headers['x-update-token'] as string | undefined;
  if (!authToken || !updateTokens.has(authToken) || Date.now() > (updateTokens.get(authToken) ?? 0)) {
    res.status(401).json({ error: '유효하지 않은 업데이트 토큰입니다.' });
    return;
  }
  updateTokens.delete(authToken);

  try {
    res.json({ success: true, message: '업데이트를 시작합니다. 약 1~2분 후 페이지를 새로고침하세요.' });

    // Run in background: brew upgrade → stop current → start new version
    // The entire sequence must complete before the process exits
    setTimeout(() => {
      logger.info('[Update] brew update && brew upgrade stock-manager 실행');

      // Detect if running from brew (libexec) or local dev
      const isBrew = __dirname.includes('/libexec/') || __dirname.includes('/Cellar/');
      const restartCmd = isBrew
        ? 'stock-manager stop; sleep 1; stock-manager start'
        : `node "${process.argv[1]}" stop; sleep 1; node "${process.argv[1]}" start`;

      const updateCmd = [
        'brew update',
        'brew upgrade stock-manager',
        restartCmd,
      ].join(' && ');

      execFile('/bin/sh', ['-c', updateCmd], {
        timeout: 300000, // 5 minutes for brew update + upgrade + restart
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      }, (err, stdout, stderr) => {
        if (err) logger.error({ err }, '[Update] 오류');
        if (stdout) logger.info({ stdout }, '[Update] stdout');
        if (stderr) logger.info({ stderr }, '[Update] stderr');
        // If stock-manager restart succeeded, this process is already replaced.
        // If it failed, exit so the user can manually restart.
        logger.info('[Update] 완료, 현재 프로세스 종료');
        process.exit(0);
      });
    }, 1000);
  } catch (err: unknown) {
    logger.error({ err }, '[Update] 실패');
    res.status(500).json({ error: '업데이트 시작 실패' });
  }
});

// ── Scheduler status ──
app.get('/api/scheduler/status', (_req, res) => {
  res.json(getSchedulerStatus());
});

// ── System events ──
app.get('/api/system-events', (req, res) => {
  const unresolved = req.query.unresolved === 'true';
  const limit = Number(req.query.limit) || 100;
  res.json(unresolved ? getUnresolvedEvents(limit) : getRecentEvents(limit));
});

app.get('/api/system-events/counts', (_req, res) => {
  res.json(getEventCounts());
});

app.post('/api/system-events/:id/resolve', (req, res) => {
  const id = Number(req.params.id);
  const { resolution } = req.body;
  resolveEvent(id, resolution || '수동 해결');
  res.json({ success: true });
});

// ── Production: client static files ──
const clientDist = process.env.STOCK_MANAGER_CLIENT || path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Error handler (LAST middleware) ──
app.use(errorHandler);

// ── Start ──
async function start() {
  getSettings();
  await initializeDB();
  startScheduler();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const wsClients = new Set<WebSocket>();

  wss.on('connection', (ws, req) => {
    // Validate WS token
    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');

    if (!token || !wsTokens.has(token) || Date.now() > (wsTokens.get(token) ?? 0)) {
      logger.warn('WebSocket connection rejected: invalid or expired token');
      ws.close(4401, 'Unauthorized');
      return;
    }

    // Consume the one-time token
    wsTokens.delete(token);

    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', message: 'Stock Manager WebSocket' }));
  });

  // Global broadcast function (used by scheduler etc.)
  (global as any).__wsBroadcast = (data: any) => {
    const msg = JSON.stringify(data);
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };

  // ── Periodic token cleanup ──
  const tokenCleanupInterval = setInterval(() => {
    cleanExpiredTokens();
    // Also clean update tokens
    const now = Date.now();
    for (const [token, expires] of updateTokens) {
      if (now > expires) updateTokens.delete(token);
    }
  }, 60000);

  // ── Graceful shutdown ──
  let isShuttingDown = false;

  function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    clearInterval(tokenCleanupInterval);
    stopScheduler();
    logger.info('Scheduler stopped');

    for (const client of wsClients) {
      client.close(1001, 'Server shutting down');
    }
    wsClients.clear();
    logger.info('WebSocket clients closed');

    wss.close(() => {
      logger.info('WebSocket server closed');
    });

    saveDB();
    logger.info('Database saved');

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(PORT, () => {
    logger.info({ port: PORT }, `Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
