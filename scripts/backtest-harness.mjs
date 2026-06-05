#!/usr/bin/env node
/**
 * 파라미터화 백테스트 하니스 — v5.7 vs v5.8 후보 A/B + ablation + 멀티 레짐.
 *
 * 핵심: 같은 유니버스·같은 기간에서 "파라미터만" 바꿔 비교하므로,
 *       시총순위 합성 추정의 절대오차와 무관하게 "변경의 효과"는 과학적으로 유효.
 *
 * 사용:
 *   node scripts/backtest-harness.mjs            # 2025 ablation (기본)
 *   node scripts/backtest-harness.mjs --regimes  # 2020/2022/2025 멀티 레짐
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────
// 종목 풀 (현재 시총 억원 — 합성 순위용 발행주수 추정)
// ─────────────────────────────────────────────────────────────
const STOCK_POOL = [
  { ticker: '005930', name: '삼성전자',         eok: 4_800_000 },
  { ticker: '000660', name: 'SK하이닉스',       eok: 1_700_000 },
  { ticker: '373220', name: 'LG에너지솔루션',   eok: 1_000_000 },
  { ticker: '207940', name: '삼성바이오로직스', eok:   700_000 },
  { ticker: '005935', name: '삼성전자우',       eok:   480_000 },
  { ticker: '005380', name: '현대차',           eok:   500_000 },
  { ticker: '000270', name: '기아',             eok:   400_000 },
  { ticker: '068270', name: '셀트리온',         eok:   400_000 },
  { ticker: '005490', name: 'POSCO홀딩스',      eok:   270_000 },
  { ticker: '035420', name: 'NAVER',            eok:   340_000 },
  { ticker: '105560', name: 'KB금융',           eok:   320_000 },
  { ticker: '035720', name: '카카오',           eok:   220_000 },
  { ticker: '012330', name: '현대모비스',       eok:   240_000 },
  { ticker: '028260', name: '삼성물산',         eok:   260_000 },
  { ticker: '055550', name: '신한지주',         eok:   280_000 },
  { ticker: '086790', name: '하나금융지주',     eok:   190_000 },
  { ticker: '015760', name: '한국전력',         eok:   170_000 },
  { ticker: '033780', name: 'KT&G',             eok:   170_000 },
  { ticker: '051910', name: 'LG화학',           eok:   220_000 },
  { ticker: '017670', name: 'SK텔레콤',         eok:   120_000 },
  { ticker: '066570', name: 'LG전자',           eok:   170_000 },
  { ticker: '329180', name: 'HD현대중공업',     eok:   330_000 },
  { ticker: '003670', name: '포스코퓨처엠',     eok:   170_000 },
  { ticker: '096770', name: 'SK이노베이션',     eok:   140_000 },
  { ticker: '047810', name: '한국항공우주',     eok:    90_000 },
];

const FEE_RATE = 0.00015;
const INIT_CAPITAL = 5_000_000;

// ─────────────────────────────────────────────────────────────
// Yahoo fetch (period1/period2 또는 range) — 디스크 캐시
// ─────────────────────────────────────────────────────────────
const CACHE_DIR = path.resolve('docs', 'backtest-v5.7', '_cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

async function fetchDaily(symbol, period1, period2) {
  const cacheFile = path.join(CACHE_DIR, `${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${period1}_${period2}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  const data = await res.json();
  const r = data.chart?.result?.[0];
  if (!r || !r.timestamp) return [];
  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close == null || !Number.isFinite(close)) continue;
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i] ?? close, close,
      high: q.high[i] ?? close, low: q.low[i] ?? close,
    });
  }
  writeFileSync(cacheFile, JSON.stringify(bars));
  return bars;
}

// ─────────────────────────────────────────────────────────────
// 데이터 로드 (기간별)
// ─────────────────────────────────────────────────────────────
async function loadRegime(name, period1, period2) {
  const kospi = await fetchDaily('^KS11', period1, period2);
  const barMap = {}, sharesOut = {}, nameOf = {};
  let loaded = 0;
  for (const s of STOCK_POOL) {
    nameOf[s.ticker] = s.name;
    try {
      const bars = await fetchDaily(`${s.ticker}.KS`, period1, period2);
      if (bars.length < 40) continue;
      barMap[s.ticker] = {};
      for (const b of bars) barMap[s.ticker][b.date] = b;
      const lastClose = bars[bars.length - 1].close;
      sharesOut[s.ticker] = (s.eok * 1e8) / lastClose;
      loaded++;
      // ATR(14) 사전계산
      barMap[s.ticker]._atr = computeATR(bars, 14);
    } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  return { name, kospi, barMap, sharesOut, nameOf, loaded };
}

// True Range 기반 ATR(14) — date → atr 맵
function computeATR(bars, period) {
  const atr = {};
  const trs = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const pc = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    trs.push(tr);
    if (i >= period - 1) {
      const slice = trs.slice(i - period + 1, i + 1);
      atr[b.date] = slice.reduce((a, c) => a + c, 0) / period;
    }
  }
  return atr;
}

// ─────────────────────────────────────────────────────────────
// 시뮬레이터 (config 기반)
// ─────────────────────────────────────────────────────────────
function simulate(regime, cfg) {
  const { kospi, barMap, sharesOut, nameOf } = regime;
  const tickers = Object.keys(barMap);
  const days = kospi.map(b => b.date);

  // KOSPI 일변동률 + 60일 롤링 평균/표준편차 (z-score용) + 5/20 MA
  const kClose = kospi.map(b => b.close);
  const kChg = kClose.map((c, i) => i === 0 ? 0 : (c - kClose[i - 1]) / kClose[i - 1] * 100);
  function kZscore(i) {
    const w = 60;
    if (i < w) return 0;
    const slice = kChg.slice(i - w, i);
    const m = slice.reduce((a, b) => a + b, 0) / w;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / w);
    return sd > 0 ? (kChg[i] - m) / sd : 0;
  }
  function kMA(i, win) {
    if (i < win - 1) return null;
    let s = 0; for (let j = i - win + 1; j <= i; j++) s += kClose[j];
    return s / win;
  }

  function ranksAt(date) {
    const list = [];
    for (const t of tickers) {
      const b = barMap[t][date];
      if (!b) continue;
      list.push({ ticker: t, mc: b.close * sharesOut[t] });
    }
    list.sort((a, b) => b.mc - a.mc);
    const r = {};
    list.forEach((s, i) => { r[s.ticker] = i + 1; });
    return r;
  }

  let cash = INIT_CAPITAL;
  const pos = {}; // ticker → {qty,totalCost,buyRank,highestPrice,trailingActive,outDays}
  const trades = [];
  const hist = [];
  const rankCache = {};

  const lastPrice = (t, i) => {
    for (let j = i; j >= 0; j--) { const b = barMap[t]?.[days[j]]; if (b) return b.close; }
    return pos[t] ? pos[t].totalCost / pos[t].qty : 0;
  };

  function buy(date, t, price, rank, reason) {
    const cost = price * (1 + FEE_RATE);
    if (cash < cost) return false;
    cash -= cost;
    const p = pos[t] ?? { qty: 0, totalCost: 0, buyRank: rank, highestPrice: price, trailingActive: false, outDays: 0 };
    p.qty += 1; p.totalCost += cost; p.buyRank = rank;
    p.highestPrice = Math.max(p.highestPrice, price); p.outDays = 0;
    pos[t] = p;
    trades.push({ date, ticker: t, type: 'BUY', qty: 1, price, reason });
    return true;
  }
  function sellAll(date, t, price, reason) {
    const p = pos[t]; if (!p) return;
    const net = price * p.qty * (1 - FEE_RATE);
    const profit = net - p.totalCost;
    const pct = p.totalCost > 0 ? profit / p.totalCost * 100 : 0;
    cash += net;
    trades.push({ date, ticker: t, type: 'SELL', qty: p.qty, price, reason, profit, pct });
    delete pos[t];
  }

  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    const chg = kChg[i];
    const z = kZscore(i);
    const ma5 = kMA(i, 5), ma20 = kMA(i, 20);
    const ranks = rankCache[date] || (rankCache[date] = ranksAt(date));

    // KOSPI 매도 트리거
    const kospiSellHit = cfg.kospiMode === 'zscore'
      ? z >= cfg.kospiSellZ : chg >= cfg.kospiSellPct;
    // KOSPI 매수차단(브레이크) + 죽는시장
    const kospiBrake = cfg.kospiMode === 'zscore'
      ? z <= -Math.abs(cfg.kospiBrakeZ ?? 1.0) : chg <= -2;
    const dying = (ma5 !== null && ma20 !== null && ma5 < ma20 && (cfg.kospiMode === 'zscore' ? z <= -1.0 : chg <= -2));

    // ───── 매도 ─────
    for (const t of Object.keys(pos)) {
      const bar = barMap[t]?.[date]; if (!bar) continue;
      const p = pos[t];
      const avg = p.totalCost / p.qty;
      p.highestPrice = Math.max(p.highestPrice, bar.high);
      const profitPct = (bar.close - avg) / avg * 100;

      // S0 하드 스톱로스 — 트레일링 활성 전(이익 미달) 종목이 손실 한계 이탈 시 손절
      // (죽는 시장에서 이익 한 번 못 내고 −25% 까지 출혈하는 것 방지)
      if (cfg.hardStopPct && !p.trailingActive) {
        const lossStop = avg * (1 - cfg.hardStopPct / 100);
        if (bar.low <= lossStop) { sellAll(date, t, Math.min(lossStop, bar.high), `손절`); continue; }
      }

      // 트레일링 활성
      if (!p.trailingActive && profitPct >= cfg.trailActivatePct) p.trailingActive = true;

      // S1 트레일링
      if (p.trailingActive) {
        let stopPrice;
        if (cfg.trailing === 'atr') {
          const atr = barMap[t]._atr[date] ?? (p.highestPrice * cfg.trailDropPct / 100);
          stopPrice = p.highestPrice - cfg.atrMult * atr;
        } else {
          stopPrice = p.highestPrice * (1 - cfg.trailDropPct / 100);
        }
        if (bar.low <= stopPrice) {
          sellAll(date, t, Math.min(stopPrice, bar.high), `트레일링`);
          continue;
        }
      }

      // S2 순위
      const cr = ranks[t] ?? 999;
      if (cfg.rankExit === 'immediate') {
        if (cr > p.buyRank) { sellAll(date, t, bar.close, `순위이탈`); continue; }
      } else { // hysteresis
        if (cr > cfg.exitRankThreshold) {
          p.outDays = (p.outDays || 0) + 1;
          if (p.outDays >= cfg.confirmDays) { sellAll(date, t, bar.close, `순위이탈`); continue; }
        } else {
          p.outDays = 0;
        }
      }

      // S3 KOSPI 스파이크
      if (kospiSellHit && profitPct >= cfg.kospiSellProfitMin) {
        sellAll(date, t, bar.close, `KOSPI매도`); continue;
      }
    }

    // ───── 매수 ─────
    if (!kospiBrake && !dying) {
      const sorted = Object.entries(ranks).sort((a, b) => a[1] - b[1]);
      const top10 = sorted.slice(0, 10).map(([t]) => t);
      const top20 = sorted.slice(0, 20).map(([t]) => t);

      if (cfg.sizing === 'targetweight') {
        // 목표비중: top N 균등, ±band 무거래
        const N = cfg.targetPositions;
        const targets = top10.slice(0, N);
        let equity = cash;
        for (const t of Object.keys(pos)) equity += pos[t].qty * lastPrice(t, i);
        const targetVal = equity / N;
        for (const t of targets) {
          const bar = barMap[t]?.[date]; if (!bar) continue;
          const held = pos[t]?.qty ?? 0;
          const heldVal = held * bar.close;
          if (heldVal < targetVal * (1 - 0.2)) {
            // 부족 → 목표까지 매수 (band 하단)
            let need = Math.floor((targetVal - heldVal) / bar.close);
            while (need > 0 && cash >= bar.close * (1 + FEE_RATE)) {
              if (!buy(date, t, bar.close, ranks[t], `목표비중`)) break;
              need--;
            }
          }
        }
      } else {
        // 1주씩 (B2 + B3 + B4)
        for (const t of top10) {
          if (pos[t]) continue;
          const bar = barMap[t]?.[date]; if (!bar || bar.close > cash) continue;
          buy(date, t, bar.close, ranks[t], `Top10진입`);
        }
        if (i > 0) {
          const prev = rankCache[days[i - 1]] || {};
          for (const t of top20.slice(10)) {
            if (pos[t]) continue;
            const pr = prev[t] ?? 999, cr = ranks[t];
            if (cr <= pr - 2) {
              const bar = barMap[t]?.[date]; if (!bar || bar.close > cash) continue;
              buy(date, t, bar.close, ranks[t], `11-20상승`);
            }
          }
        }
        for (let k = 0; k < 30; k++) {
          if (cash <= 0) break;
          const cand = top10.filter(t => pos[t]).map(t => {
            const bar = barMap[t]?.[date];
            if (!bar || bar.close > cash) return null;
            return { t, close: bar.close, ev: pos[t].qty * bar.close };
          }).filter(Boolean).sort((a, b) => a.ev - b.ev);
          if (!cand.length) break;
          if (!buy(date, cand[0].t, cand[0].close, ranks[cand[0].t], `재분배`)) break;
        }
      }
    }

    // 일별 평가
    let hold = 0;
    for (const t of Object.keys(pos)) hold += pos[t].qty * lastPrice(t, i);
    hist.push({ date, total: cash + hold, cash, hold, kospi: kClose[i] });
  }

  // 지표
  const final = hist[hist.length - 1].total;
  const ret = (final - INIT_CAPITAL) / INIT_CAPITAL * 100;
  let peak = INIT_CAPITAL, mdd = 0;
  for (const h of hist) { if (h.total > peak) peak = h.total; const dd = (peak - h.total) / peak * 100; if (dd > mdd) mdd = dd; }
  // 일수익률 → Sharpe (연율화, rf=0)
  const dr = hist.map((h, i) => i === 0 ? 0 : (h.total - hist[i - 1].total) / hist[i - 1].total);
  const drm = dr.reduce((a, b) => a + b, 0) / dr.length;
  const drsd = Math.sqrt(dr.reduce((a, b) => a + (b - drm) ** 2, 0) / dr.length);
  const sharpe = drsd > 0 ? (drm / drsd) * Math.sqrt(252) : 0;
  const sells = trades.filter(t => t.type === 'SELL');
  const wins = sells.filter(t => t.profit > 0).length;
  const kStart = kClose[0], kEnd = kClose[kClose.length - 1];
  const kRet = (kEnd - kStart) / kStart * 100;

  return {
    cfg: cfg.name, regime: regime.name,
    finalValue: Math.round(final), ret, mdd, sharpe,
    buys: trades.filter(t => t.type === 'BUY').length, sells: sells.length,
    winRate: sells.length ? wins / sells.length * 100 : 0,
    kospiRet: kRet, alpha: ret - kRet,
    trades,
  };
}

// ─────────────────────────────────────────────────────────────
// Config 정의
// ─────────────────────────────────────────────────────────────
const BASE = {
  name: 'C0-v5.7baseline',
  rankExit: 'immediate', exitRankThreshold: 20, confirmDays: 2,
  trailing: 'fixed', trailActivatePct: 10, trailDropPct: 2, atrMult: 3,
  kospiMode: 'fixed', kospiSellPct: 4, kospiBuyPct: -4, kospiSellProfitMin: 5,
  kospiSellZ: 1.5, kospiBrakeZ: 1.0,
  sizing: 'oneshare', targetPositions: 10,
};
const mk = (over) => ({ ...BASE, ...over });

const CONFIGS = [
  BASE,
  mk({ name: 'C1-히스테리시스만', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2 }),
  mk({ name: 'C2-ATR트레일만', trailing: 'atr', atrMult: 3 }),
  mk({ name: 'C3-완화트레일만', trailDropPct: 6, trailActivatePct: 7 }),
  mk({ name: 'C4-zscoreKOSPI만', kospiMode: 'zscore' }),
  mk({ name: 'C5-목표비중만', sizing: 'targetweight', targetPositions: 8 }),
  // 수정된 통합: 타이트 트레일링 유지(폭등장 검증) + 히스테리시스 + 목표비중 + zscore
  mk({ name: 'C9-v5.8(히스+비중)', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, sizing: 'targetweight', targetPositions: 8 }),
  mk({ name: 'C10-v5.8(전체)', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, sizing: 'targetweight', targetPositions: 8, kospiMode: 'zscore' }),
  mk({ name: 'C11-히스+비중+ATR', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, sizing: 'targetweight', targetPositions: 8, trailing: 'atr', atrMult: 2.5, kospiMode: 'zscore' }),
  mk({ name: 'C12-완화트레일(하락장용)', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, sizing: 'targetweight', targetPositions: 8, trailDropPct: 5, trailActivatePct: 5 }),
  mk({ name: 'C13-C10+손절8%', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, sizing: 'targetweight', targetPositions: 8, kospiMode: 'zscore', hardStopPct: 8 }),
  mk({ name: 'C14-C10+손절12%', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, sizing: 'targetweight', targetPositions: 8, kospiMode: 'zscore', hardStopPct: 12 }),
  // 실제 배포 후보 — 목표비중 제외(주문크기 변경 blast radius 회피), 1주씩 유지
  mk({ name: 'C16-배포후보(v5.8)', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2, kospiMode: 'zscore' }),
];

// ─────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────
function unix(d) { return Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000); }
const REGIMES = {
  '2025_bull':  { p1: unix('2025-06-05'), p2: unix('2026-06-05') },
  '2022_bear':  { p1: unix('2022-01-01'), p2: unix('2022-12-31') },
  '2020_crash': { p1: unix('2020-01-01'), p2: unix('2020-12-31') },
};

const wantRegimes = process.argv.includes('--regimes');

function fmtRow(r) {
  return `${r.cfg.padEnd(22)} ${(r.ret>=0?'+':'')+r.ret.toFixed(1).padStart(6)}%  ` +
    `MDD ${r.mdd.toFixed(1).padStart(5)}%  Sharpe ${r.sharpe.toFixed(2).padStart(5)}  ` +
    `α ${(r.alpha>=0?'+':'')+r.alpha.toFixed(1).padStart(6)}%p  ` +
    `매수 ${String(r.buys).padStart(3)} 매도 ${String(r.sells).padStart(3)} 승률 ${r.winRate.toFixed(0).padStart(3)}%`;
}

console.log('📥 데이터 로드...\n');

if (!wantRegimes) {
  // 2025 ablation
  const regime = await loadRegime('2025_bull', REGIMES['2025_bull'].p1, REGIMES['2025_bull'].p2);
  console.log(`종목 ${regime.loaded}개, KOSPI ${regime.kospi.length}봉 (${regime.kospi[0].date}~${regime.kospi[regime.kospi.length-1].date})`);
  console.log(`KOSPI 수익률: ${((regime.kospi[regime.kospi.length-1].close - regime.kospi[0].close)/regime.kospi[0].close*100).toFixed(1)}%\n`);
  console.log('═══════════════ 2025 ABLATION (각 변경 기여도) ═══════════════');
  const results = [];
  for (const cfg of CONFIGS) {
    const r = simulate(regime, cfg);
    results.push(r);
    console.log(fmtRow(r));
  }
  // 순위이탈 손익 분해 (baseline vs C1)
  console.log('\n── 순위이탈 매도 손익 (baseline) ──');
  const base = results[0];
  const rankSells = base.trades.filter(t => t.type==='SELL' && t.reason==='순위이탈');
  const rankPnl = rankSells.reduce((a,t)=>a+t.profit,0);
  console.log(`  ${rankSells.length}건, 합계 ${Math.round(rankPnl).toLocaleString()}원, 평균 ${(rankSells.reduce((a,t)=>a+t.pct,0)/rankSells.length).toFixed(2)}%`);
} else {
  // 멀티 레짐: baseline vs C6 vs C7 vs C8
  const compareConfigs = CONFIGS.filter(c => ['C0-v5.7baseline','C16-배포후보(v5.8)','C10-v5.8(전체)'].includes(c.name));
  for (const [rname, { p1, p2 }] of Object.entries(REGIMES)) {
    const regime = await loadRegime(rname, p1, p2);
    const kRet = (regime.kospi[regime.kospi.length-1].close - regime.kospi[0].close)/regime.kospi[0].close*100;
    console.log(`\n═══════════ ${rname} (종목 ${regime.loaded}, KOSPI ${kRet>=0?'+':''}${kRet.toFixed(1)}%) ═══════════`);
    for (const cfg of compareConfigs) {
      console.log(fmtRow(simulate(regime, cfg)));
    }
  }
}
console.log('\n완료.');
