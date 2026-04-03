import express from 'express';
import cors from 'cors';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { initializeDB } from './db';
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
import { getSettings } from './services/settings';
import { startScheduler, getSchedulerStatus } from './services/scheduler';
import { getRecentEvents, getUnresolvedEvents, getEventCounts, resolveEvent } from './services/systemEvent';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 버전 + 업데이트 확인
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
  } catch {}
  res.json({ currentVersion, latestVersion, updateAvailable });
});

// 업데이트 실행 (brew upgrade + 자동 재시작)
app.post('/api/update', (_req, res) => {
  const { exec } = require('child_process');
  try {
    res.json({ success: true, message: '업데이트를 시작합니다. 약 1~2분 후 페이지를 새로고침하세요.' });

    // 비동기로: stop → brew upgrade → start
    setTimeout(() => {
      const stockManagerBin = process.argv[1] || 'stock-manager';
      const cmd = `brew update && brew upgrade stock-manager && node "${stockManagerBin}" start`;
      console.log(`[Update] 실행: ${cmd}`);

      exec(cmd, { timeout: 180000 }, (err: any, stdout: string, stderr: string) => {
        if (err) console.log(`[Update] 오류: ${err.message}`);
        if (stdout) console.log(`[Update] ${stdout}`);
        if (stderr) console.log(`[Update] ${stderr}`);
      });

      // 현재 서버는 2초 후 종료 (새 서버가 start로 시작됨)
      setTimeout(() => process.exit(0), 2000);
    }, 1000);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 프로덕션: 클라이언트 정적 파일 서빙
const clientDist = process.env.STOCK_MANAGER_CLIENT || path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.get('/api/scheduler/status', (_req, res) => {
  res.json(getSchedulerStatus());
});

// 시스템 이벤트 로그 API
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

async function start() {
  // 저장된 설정 로드 (환경변수 동기화 포함)
  getSettings();
  await initializeDB();
  startScheduler();

  // HTTP + WebSocket 서버
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const wsClients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', message: 'Stock Manager WebSocket' }));
  });

  // 글로벌 브로드캐스트 함수 (scheduler 등에서 사용)
  (global as any).__wsBroadcast = (data: any) => {
    const msg = JSON.stringify(data);
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  };

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
