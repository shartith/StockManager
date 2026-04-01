import express from 'express';
import cors from 'cors';
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

app.get('/api/scheduler/status', (_req, res) => {
  res.json(getSchedulerStatus());
});

async function start() {
  // 저장된 설정 로드 (환경변수 동기화 포함)
  getSettings();
  await initializeDB();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
