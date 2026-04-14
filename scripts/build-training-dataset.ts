/**
 * build-training-dataset.ts
 *
 * Refines stock-data/ jsonl exports into flat CSV datasets for ML training.
 *
 * Inputs (per-device, per-date):
 *   stock-data/device-*\/YYYY-MM-DD/trade_signals.jsonl
 *   stock-data/device-*\/YYYY-MM-DD/auto_trades.jsonl
 *
 * Outputs:
 *   datasets/signal_features.csv   - one row per signal with flat indicators
 *   datasets/trade_outcomes.csv    - FIFO-paired BUY/SELL realized returns
 *   datasets/signal_outcomes.csv   - signals joined to nearest subsequent FILLED trade
 *   datasets/README.md             - schema & EDA summary
 *
 * Usage:
 *   npx tsx scripts/build-training-dataset.ts
 */

import fs from 'node:fs';
import path from 'node:path';

type Signal = {
  id: number;
  stock_id: number;
  signal_type: 'BUY' | 'SELL' | 'HOLD';
  source: string;
  confidence: number;
  indicators_json: string;
  llm_reasoning: string;
  created_at: string;
  performance_tracked: number;
  _device: string;
  _uid: string;
};

type AutoTrade = {
  id: number;
  stock_id: number;
  signal_id: number | null;
  order_type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  fee: number;
  status: string;
  kis_order_no: string;
  error_message: string;
  created_at: string;
  executed_at: string;
  split_stage: number;
  _device: string;
  _uid: string;
};

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'stock-data');
const OUT_DIR = path.join(ROOT, 'datasets');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

function parseTimestamp(s: string): number {
  // 'YYYY-MM-DD HH:MM:SS' treated as UTC for stable diffs
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(file: string, rows: Record<string, unknown>[], columns: string[]): void {
  const lines = [columns.join(',')];
  for (const r of rows) {
    lines.push(columns.map((c) => csvEscape(r[c])).join(','));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function discoverDeviceDatePairs(): Array<{ device: string; date: string; dir: string }> {
  const pairs: Array<{ device: string; date: string; dir: string }> = [];
  if (!fs.existsSync(DATA_DIR)) return pairs;
  for (const device of fs.readdirSync(DATA_DIR)) {
    const devDir = path.join(DATA_DIR, device);
    if (!fs.statSync(devDir).isDirectory()) continue;
    for (const date of fs.readdirSync(devDir)) {
      const dateDir = path.join(devDir, date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (fs.statSync(dateDir).isDirectory()) pairs.push({ device, date, dir: dateDir });
    }
  }
  return pairs;
}

function loadAllSignals(): Signal[] {
  const byUid = new Map<string, Signal>();
  for (const { device, dir } of discoverDeviceDatePairs()) {
    const rows = readJsonl<Omit<Signal, '_device' | '_uid'>>(path.join(dir, 'trade_signals.jsonl'));
    for (const r of rows) {
      const uid = `${device}:${r.id}`;
      if (!byUid.has(uid)) byUid.set(uid, { ...r, _device: device, _uid: uid });
    }
  }
  return [...byUid.values()].sort((a, b) => parseTimestamp(a.created_at) - parseTimestamp(b.created_at));
}

function loadAllTrades(): AutoTrade[] {
  const byUid = new Map<string, AutoTrade>();
  for (const { device, dir } of discoverDeviceDatePairs()) {
    const rows = readJsonl<Omit<AutoTrade, '_device' | '_uid'>>(path.join(dir, 'auto_trades.jsonl'));
    for (const r of rows) {
      const uid = `${device}:${r.id}`;
      if (!byUid.has(uid)) byUid.set(uid, { ...r, _device: device, _uid: uid });
    }
  }
  return [...byUid.values()].sort((a, b) => parseTimestamp(a.created_at) - parseTimestamp(b.created_at));
}

// ---------------------------------------------------------------------------
// Dataset 1: signal_features.csv
// ---------------------------------------------------------------------------

const SIGNAL_COLUMNS = [
  'uid',
  'device',
  'signal_id',
  'stock_id',
  'created_at',
  'source',
  'signal_type',
  'confidence',
  'entry_price',
  'target_price',
  'stop_loss_price',
  'target_upside_pct',
  'stop_downside_pct',
  'rsi14',
  'sma5',
  'sma20',
  'sma60',
  'sma120',
  'ema12',
  'ema26',
  'macd',
  'macd_signal',
  'macd_histogram',
  'bb_upper',
  'bb_middle',
  'bb_lower',
  'bb_width_pct',
  'vwap',
  'atr14',
  'technical_signal',
  'technical_reasons_count',
  'volume_avg_20d',
  'volume_today_vs_avg',
  'volume_trend',
  'key_factors_count',
  'risks_count',
  'reasoning_len',
  'reasoning',
];

function buildSignalFeatures(signals: Signal[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of signals) {
    let ind: any = {};
    try {
      ind = JSON.parse(s.indicators_json || '{}');
    } catch {
      ind = {};
    }
    const ic = ind.indicators ?? {};
    const va = ind.volumeAnalysis ?? {};
    const kf = Array.isArray(ind.keyFactors) ? ind.keyFactors.length : 0;
    const rk = Array.isArray(ind.risks) ? ind.risks.length : 0;
    const tr = Array.isArray(ic.technicalReasons) ? ic.technicalReasons.length : 0;

    const entry = num(ind.entryPrice);
    const target = num(ind.targetPrice);
    const stop = num(ind.stopLossPrice);
    const bbU = num(ic.bollingerUpper);
    const bbL = num(ic.bollingerLower);
    const bbM = num(ic.bollingerMiddle);

    out.push({
      uid: s._uid,
      device: s._device,
      signal_id: s.id,
      stock_id: s.stock_id,
      created_at: s.created_at,
      source: s.source,
      signal_type: s.signal_type,
      confidence: s.confidence,
      entry_price: entry,
      target_price: target,
      stop_loss_price: stop,
      target_upside_pct: entry && target ? ((target - entry) / entry) * 100 : null,
      stop_downside_pct: entry && stop ? ((stop - entry) / entry) * 100 : null,
      rsi14: num(ic.rsi14),
      sma5: num(ic.sma5),
      sma20: num(ic.sma20),
      sma60: num(ic.sma60),
      sma120: num(ic.sma120),
      ema12: num(ic.ema12),
      ema26: num(ic.ema26),
      macd: num(ic.macd),
      macd_signal: num(ic.macdSignal),
      macd_histogram: num(ic.macdHistogram),
      bb_upper: bbU,
      bb_middle: bbM,
      bb_lower: bbL,
      bb_width_pct: bbU && bbL && bbM ? ((bbU - bbL) / bbM) * 100 : null,
      vwap: num(ic.vwap),
      atr14: num(ic.atr14),
      technical_signal: ic.technicalSignal ?? '',
      technical_reasons_count: tr,
      volume_avg_20d: num(va.avgVolume20d),
      volume_today_vs_avg: num(va.todayVsAvg),
      volume_trend: va.volumeTrend ?? '',
      key_factors_count: kf,
      risks_count: rk,
      reasoning_len: s.llm_reasoning?.length ?? 0,
      reasoning: s.llm_reasoning ?? '',
    });
  }
  return out;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Dataset 2: trade_outcomes.csv (FIFO pairing)
// ---------------------------------------------------------------------------

type OutcomeRow = {
  stock_id: number;
  buy_uid: string;
  buy_time: string;
  buy_price: number;
  buy_qty: number;
  buy_fee_per_share: number;
  sell_uid: string;
  sell_time: string;
  sell_price: number;
  sell_fee_per_share: number;
  matched_qty: number;
  hold_minutes: number;
  gross_return_pct: number;
  net_return_pct: number;
};

function buildTradeOutcomes(trades: AutoTrade[]): OutcomeRow[] {
  const filled = trades.filter((t) => t.status === 'FILLED');
  const byStock = new Map<number, AutoTrade[]>();
  for (const t of filled) {
    if (!byStock.has(t.stock_id)) byStock.set(t.stock_id, []);
    byStock.get(t.stock_id)!.push(t);
  }

  const rows: OutcomeRow[] = [];
  for (const [stockId, list] of byStock) {
    list.sort((a, b) => parseTimestamp(a.executed_at || a.created_at) - parseTimestamp(b.executed_at || b.created_at));
    // FIFO queue of open BUYs: each entry is {trade, remaining}
    const openBuys: Array<{ t: AutoTrade; remaining: number }> = [];
    for (const t of list) {
      if (t.order_type === 'BUY') {
        openBuys.push({ t, remaining: t.quantity });
      } else {
        let needed = t.quantity;
        while (needed > 0 && openBuys.length > 0) {
          const head = openBuys[0];
          const qty = Math.min(head.remaining, needed);
          const buyTime = parseTimestamp(head.t.executed_at || head.t.created_at);
          const sellTime = parseTimestamp(t.executed_at || t.created_at);
          const buyFeePerShare = head.t.fee / Math.max(head.t.quantity, 1);
          const sellFeePerShare = t.fee / Math.max(t.quantity, 1);
          const gross = ((t.price - head.t.price) / head.t.price) * 100;
          const net = ((t.price - head.t.price - buyFeePerShare - sellFeePerShare) / head.t.price) * 100;
          rows.push({
            stock_id: stockId,
            buy_uid: head.t._uid,
            buy_time: head.t.executed_at || head.t.created_at,
            buy_price: head.t.price,
            buy_qty: head.t.quantity,
            buy_fee_per_share: round(buyFeePerShare, 4),
            sell_uid: t._uid,
            sell_time: t.executed_at || t.created_at,
            sell_price: t.price,
            sell_fee_per_share: round(sellFeePerShare, 4),
            matched_qty: qty,
            hold_minutes: Math.round((sellTime - buyTime) / 60000),
            gross_return_pct: round(gross, 4),
            net_return_pct: round(net, 4),
          });
          head.remaining -= qty;
          needed -= qty;
          if (head.remaining === 0) openBuys.shift();
        }
        // Unmatched sells (from sync) are silently ignored
      }
    }
  }
  return rows.sort((a, b) => parseTimestamp(a.buy_time) - parseTimestamp(b.buy_time));
}

function round(n: number, d: number): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

// ---------------------------------------------------------------------------
// Dataset 3: signal_outcomes.csv (weak labels)
// ---------------------------------------------------------------------------

type SignalOutcomeRow = {
  uid: string;
  stock_id: number;
  signal_type: string;
  source: string;
  confidence: number;
  created_at: string;
  filled_within_60min: 0 | 1;
  fill_uid: string;
  fill_order_type: string;
  fill_price: number | null;
  fill_time: string;
  minutes_to_fill: number | null;
  realized_return_pct: number | null;
};

function buildSignalOutcomes(signals: Signal[], trades: AutoTrade[], outcomes: OutcomeRow[]): SignalOutcomeRow[] {
  const filledByStock = new Map<number, AutoTrade[]>();
  for (const t of trades.filter((x) => x.status === 'FILLED')) {
    if (!filledByStock.has(t.stock_id)) filledByStock.set(t.stock_id, []);
    filledByStock.get(t.stock_id)!.push(t);
  }
  for (const list of filledByStock.values()) {
    list.sort((a, b) => parseTimestamp(a.created_at) - parseTimestamp(b.created_at));
  }

  // buy_uid -> first realized outcome
  const outcomeByBuyUid = new Map<string, OutcomeRow>();
  for (const o of outcomes) {
    if (!outcomeByBuyUid.has(o.buy_uid)) outcomeByBuyUid.set(o.buy_uid, o);
  }

  const WINDOW_MS = 60 * 60 * 1000; // 60 min
  const rows: SignalOutcomeRow[] = [];
  for (const s of signals) {
    const sTime = parseTimestamp(s.created_at);
    const pool = filledByStock.get(s.stock_id) ?? [];
    // nearest subsequent fill within window
    let nearest: AutoTrade | null = null;
    for (const t of pool) {
      const tTime = parseTimestamp(t.created_at);
      if (tTime < sTime) continue;
      if (tTime - sTime > WINDOW_MS) break;
      nearest = t;
      break;
    }
    const outcome = nearest ? outcomeByBuyUid.get(nearest._uid) : undefined;
    rows.push({
      uid: s._uid,
      stock_id: s.stock_id,
      signal_type: s.signal_type,
      source: s.source,
      confidence: s.confidence,
      created_at: s.created_at,
      filled_within_60min: nearest ? 1 : 0,
      fill_uid: nearest?._uid ?? '',
      fill_order_type: nearest?.order_type ?? '',
      fill_price: nearest?.price ?? null,
      fill_time: nearest?.created_at ?? '',
      minutes_to_fill: nearest ? Math.round((parseTimestamp(nearest.created_at) - sTime) / 60000) : null,
      realized_return_pct: outcome?.net_return_pct ?? null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// EDA / README
// ---------------------------------------------------------------------------

function writeReadme(
  signals: Signal[],
  trades: AutoTrade[],
  outcomes: OutcomeRow[],
  signalOutcomes: SignalOutcomeRow[],
): void {
  const filled = trades.filter((t) => t.status === 'FILLED');
  const typeDist = count(signals.map((s) => s.signal_type));
  const sourceDist = count(signals.map((s) => s.source));
  const statusDist = count(trades.map((t) => t.status));
  const dates = new Set(signals.map((s) => s.created_at.slice(0, 10)));

  const labeled = signalOutcomes.filter((r) => r.realized_return_pct !== null);
  const winRate = labeled.length
    ? (labeled.filter((r) => (r.realized_return_pct ?? 0) > 0).length / labeled.length) * 100
    : 0;
  const avgRet = labeled.length
    ? labeled.reduce((a, r) => a + (r.realized_return_pct ?? 0), 0) / labeled.length
    : 0;

  const md = `# Training Dataset

Generated by \`scripts/build-training-dataset.ts\`.

## Source

- \`stock-data/device-*\\/YYYY-MM-DD/trade_signals.jsonl\`
- \`stock-data/device-*\\/YYYY-MM-DD/auto_trades.jsonl\`

Unique key across devices: \`{device}:{id}\`.

## Files

### \`signal_features.csv\` — ${signals.length} rows
Flattened indicators + LLM reasoning per signal. One row per signal.
Useful for: signal-quality classifier, LLM distillation (input = indicators JSON, target = reasoning).

### \`trade_outcomes.csv\` — ${outcomes.length} rows
FIFO-paired BUY↔SELL of **FILLED** auto_trades. Per-lot realized returns (gross & net of fee).

### \`signal_outcomes.csv\` — ${signalOutcomes.length} rows
Each signal joined to the nearest FILLED auto_trade on the same \`stock_id\` within **+60 minutes**.
Weak label: \`filled_within_60min\`. If the fill later closes out via SELL, \`realized_return_pct\` is populated.

## Distribution

- **Dates covered:** ${[...dates].sort().join(', ')} (${dates.size} days)
- **Signal types:** ${JSON.stringify(typeDist)}
- **Signal sources:** ${JSON.stringify(sourceDist)}
- **Auto-trade status:** ${JSON.stringify(statusDist)}
- **FILLED trades:** ${filled.length}
- **Realized-return-labeled signals:** ${labeled.length} (win rate ${winRate.toFixed(1)}%, avg net return ${avgRet.toFixed(2)}%)

## Known Limitations

1. **Short history.** ~1–2 weeks of data; insufficient for RL or deep temporal models.
2. **No price history join.** Forward returns beyond fills are **not** computed — we don't have intraday price series here. Extend by joining \`stockPrice\` service if available.
3. **signal_id is null on auto_trades.** The ↔ signal link is reconstructed heuristically via \`(stock_id, time window)\`, not foreign key. Mismatches possible.
4. **FAILED orders dominate (${statusDist['FAILED'] ?? 0} vs ${statusDist['FILLED'] ?? 0} FILLED).** Strong imbalance — consider modeling fill success as a separate task.
5. **KIS-sync SELL rows (2026-04-14 08:57:26)** batch-timestamped; treat their timing as unreliable.
6. **Heavy stock_id concentration.** A few tickers dominate — random split will leak; use stratified or time-based split.
7. **Look-ahead risk.** Verify \`indicators_json\` is a point-in-time snapshot, not recomputed.

## Suggested Splits

- **Time-based:** train ≤ last-day-minus-1, val = last day. Prevents leakage across correlated same-day signals.
- **Stock-held-out:** holdout a set of \`stock_id\` entirely for generalization tests.
`;
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), md);
}

function count<T>(arr: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of arr) out[String(v)] = (out[String(v)] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[1/4] Loading signals & trades...');
  const signals = loadAllSignals();
  const trades = loadAllTrades();
  console.log(`      signals=${signals.length}  trades=${trades.length}`);

  console.log('[2/4] Building signal_features.csv');
  const features = buildSignalFeatures(signals);
  writeCsv(path.join(OUT_DIR, 'signal_features.csv'), features, SIGNAL_COLUMNS);

  console.log('[3/4] Building trade_outcomes.csv (FIFO pairing)');
  const outcomes = buildTradeOutcomes(trades);
  writeCsv(path.join(OUT_DIR, 'trade_outcomes.csv'), outcomes as unknown as Record<string, unknown>[], [
    'stock_id',
    'buy_uid',
    'buy_time',
    'buy_price',
    'buy_qty',
    'buy_fee_per_share',
    'sell_uid',
    'sell_time',
    'sell_price',
    'sell_fee_per_share',
    'matched_qty',
    'hold_minutes',
    'gross_return_pct',
    'net_return_pct',
  ]);

  console.log('[4/4] Building signal_outcomes.csv (weak labels)');
  const signalOutcomes = buildSignalOutcomes(signals, trades, outcomes);
  writeCsv(path.join(OUT_DIR, 'signal_outcomes.csv'), signalOutcomes as unknown as Record<string, unknown>[], [
    'uid',
    'stock_id',
    'signal_type',
    'source',
    'confidence',
    'created_at',
    'filled_within_60min',
    'fill_uid',
    'fill_order_type',
    'fill_price',
    'fill_time',
    'minutes_to_fill',
    'realized_return_pct',
  ]);

  writeReadme(signals, trades, outcomes, signalOutcomes);

  console.log('\nDone. Output written to:', OUT_DIR);
}

main();
