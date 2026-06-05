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

// 현실적 거래비용 (이전 버그: 양방향 0.015% → 매도세 10배 과소계상)
//   매수: 위탁수수료 ~0.015% (KIS 온라인)
//   매도: 위탁수수료 + 증권거래세/농특세 ≈ 0.20% (2020~2022 0.23%, 2025 0.15% 의 대표값)
const BUY_FEE = 0.00015;
const SELL_FEE = 0.0020;
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
// 데이터 로드 (기간별) — leadDays 워밍업 포함 (200일선/모멘텀 계산용)
// 거래/평가는 tradeStartIdx 부터, 그 이전은 지표 워밍업만.
// ─────────────────────────────────────────────────────────────
const LEAD_SECONDS = 400 * 24 * 60 * 60; // 200일선 워밍업 여유

async function loadRegime(name, period1, period2) {
  const fetchFrom = period1 - LEAD_SECONDS;
  const tradeStartDate = new Date(period1 * 1000).toISOString().slice(0, 10);
  const kospi = await fetchDaily('^KS11', fetchFrom, period2); // 워밍업 포함 전체
  const tradeStartIdx = Math.max(0, kospi.findIndex(b => b.date >= tradeStartDate));

  const barMap = {}, sharesOut = {}, nameOf = {};
  let loaded = 0;
  for (const s of STOCK_POOL) {
    nameOf[s.ticker] = s.name;
    try {
      const bars = await fetchDaily(`${s.ticker}.KS`, fetchFrom, period2);
      // 거래기간 내 봉이 40개 미만이면 제외
      const inWindow = bars.filter(b => b.date >= tradeStartDate);
      if (inWindow.length < 40) continue;
      barMap[s.ticker] = {};
      for (const b of bars) barMap[s.ticker][b.date] = b;
      const lastClose = bars[bars.length - 1].close;
      sharesOut[s.ticker] = (s.eok * 1e8) / lastClose;
      loaded++;
      barMap[s.ticker]._atr = computeATR(bars, 14);
    } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  return { name, kospi, barMap, sharesOut, nameOf, loaded, tradeStartIdx };
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
  const tradeStartIdx = regime.tradeStartIdx ?? 0;
  const tickers = Object.keys(barMap);
  const days = kospi.map(b => b.date);
  const dateIdx = {}; days.forEach((d, i) => { dateIdx[d] = i; });

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

  // 선택 기준: 시총(marketcap) 또는 가격모멘텀(momentum, trailing N일 수익률)
  function ranksAt(date) {
    const i = dateIdx[date];
    const momWin = cfg.momentumWindow ?? 120;
    const list = [];
    for (const t of tickers) {
      const b = barMap[t][date];
      if (!b) continue;
      let score;
      if (cfg.selection === 'momentum') {
        // trailing momWin 일 수익률 (워밍업 데이터로 lookback). 데이터 부족 시 제외.
        const pastDate = days[i - momWin];
        const pastBar = pastDate ? barMap[t][pastDate] : null;
        if (!pastBar || pastBar.close <= 0) continue;
        score = (b.close - pastBar.close) / pastBar.close; // 높을수록 1위
      } else {
        score = b.close * sharesOut[t]; // 시총
      }
      list.push({ ticker: t, score });
    }
    list.sort((a, b) => b.score - a.score);
    const r = {};
    list.forEach((s, idx) => { r[s.ticker] = idx + 1; });
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

  let soldTodaySet = new Set(); // ❶ 재매수 쿨다운 — 당일 매도 종목
  function buy(date, t, price, rank, reason, isDeepBuy = false) {
    const cost = price * (1 + BUY_FEE);
    if (cash < cost) return false;
    cash -= cost;
    const p = pos[t] ?? { qty: 0, totalCost: 0, buyRank: rank, highestPrice: price, trailingActive: false, outDays: 0, isDeepBuy };
    p.qty += 1; p.totalCost += cost; p.buyRank = rank;
    p.highestPrice = Math.max(p.highestPrice, price); p.outDays = 0;
    if (isDeepBuy) p.isDeepBuy = true; // 딥바이 태그는 한번 붙으면 유지
    pos[t] = p;
    trades.push({ date, ticker: t, type: 'BUY', qty: 1, price, reason });
    return true;
  }
  function sellAll(date, t, price, reason) {
    const p = pos[t]; if (!p) return;
    const net = price * p.qty * (1 - SELL_FEE);
    const profit = net - p.totalCost;
    const pct = p.totalCost > 0 ? profit / p.totalCost * 100 : 0;
    cash += net;
    trades.push({ date, ticker: t, type: 'SELL', qty: p.qty, price, reason, profit, pct });
    delete pos[t];
    soldTodaySet.add(t); // ❶ 당일 재매수 차단용
  }

  for (let i = 0; i < days.length; i++) {
    if (i < tradeStartIdx) continue; // 워밍업 구간 — 지표만 데우고 거래·평가 안 함
    const date = days[i];
    const chg = kChg[i];
    const z = kZscore(i);
    const ma5 = kMA(i, 5), ma20 = kMA(i, 20);
    const ranks = rankCache[date] || (rankCache[date] = ranksAt(date));
    soldTodaySet = new Set(); // 매일 초기화 (❶ 쿨다운은 "당일" 범위)

    // KOSPI 매도 트리거
    const kospiSellHit = cfg.kospiMode === 'zscore'
      ? z >= cfg.kospiSellZ : chg >= cfg.kospiSellPct;
    // KOSPI 매수차단(브레이크) + 죽는시장
    const kospiBrake = cfg.kospiMode === 'zscore'
      ? z <= -Math.abs(cfg.kospiBrakeZ ?? 1.0) : chg <= -2;
    const dying = (ma5 !== null && ma20 !== null && ma5 < ma20 && (cfg.kospiMode === 'zscore' ? z <= -1.0 : chg <= -2));
    // 200일선 레짐 필터 — KOSPI 가 장기추세선 아래면 약세장 판정 → 신규 매수 차단(보유 유지)
    const ma200 = kMA(i, 200);
    const regimeOff = cfg.regimeFilter === '200ma' && ma200 !== null && kClose[i] < ma200;

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
      // ❷ 딥바이 전용 손절 — 역추세(공포) 진입분만 제한적 손절 (연속 하락 방어)
      if (cfg.deepBuyStopPct && p.isDeepBuy && !p.trailingActive) {
        const dipStop = avg * (1 - cfg.deepBuyStopPct / 100);
        if (bar.low <= dipStop) { sellAll(date, t, Math.min(dipStop, bar.high), `딥손절`); continue; }
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

    // ❶ 재매수 쿨다운 헬퍼 — cfg.rebuyCooldown 일 때 당일 매도 종목 매수 차단
    const blocked = (t) => cfg.rebuyCooldown && soldTodaySet.has(t);

    // ❷ 딥바이 — KOSPI 급락(deepBuyTrigger 이하)일 때 브레이크 무시하고 역추세 매수
    //   crash floor(deepBuyFloor) 미만 폭락은 너무 위험해 제외(선택).
    const isDeepBuyDay = cfg.deepBuyTrigger != null
      && chg <= cfg.deepBuyTrigger
      && chg > (cfg.deepBuyFloor ?? -100);
    if (isDeepBuyDay) {
      const sorted = Object.entries(ranks).sort((a, b) => a[1] - b[1]);
      const top10 = sorted.slice(0, 10).map(([t]) => t);
      // 공포 구간: 미보유 Top 10 을 1주씩 매수, deepBuy 태그
      for (const t of top10) {
        if (pos[t] && !cfg.deepBuyAddOn) continue; // 기본은 미보유만; addOn 이면 보유분도 추가
        if (blocked(t)) continue;
        const bar = barMap[t]?.[date]; if (!bar || bar.close > cash) continue;
        buy(date, t, bar.close, ranks[t], `딥바이 (KOSPI ${chg.toFixed(1)}%)`, true);
      }
    }

    // ───── 일반 매수 ───── (200일선 약세장이면 신규 매수 중단, 보유는 유지)
    if (!kospiBrake && !dying && !isDeepBuyDay && !regimeOff) {
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
            while (need > 0 && cash >= bar.close * (1 + BUY_FEE)) {
              if (!buy(date, t, bar.close, ranks[t], `목표비중`)) break;
              need--;
            }
          }
        }
      } else {
        // 현금 리저브 — 일반 매수는 equity 의 (1-reserve) 까지만 투자, 나머지는 딥바이용 실탄
        let equityNow = cash;
        for (const t of Object.keys(pos)) equityNow += pos[t].qty * lastPrice(t, i);
        const reserveFloor = (cfg.cashReservePct ?? 0) / 100 * equityNow;
        const canBuyNormal = (price) => cash - price * (1 + BUY_FEE) >= reserveFloor;

        // 1주씩 (B2 + B3 + B4) — blocked(): ❶ 당일 매도 종목 재매수 차단
        for (const t of top10) {
          if (pos[t] || blocked(t)) continue;
          const bar = barMap[t]?.[date]; if (!bar || bar.close > cash) continue;
          if (!canBuyNormal(bar.close)) continue;
          buy(date, t, bar.close, ranks[t], `Top10진입`);
        }
        if (i > 0) {
          const prev = rankCache[days[i - 1]] || {};
          for (const t of top20.slice(10)) {
            if (pos[t] || blocked(t)) continue;
            const pr = prev[t] ?? 999, cr = ranks[t];
            if (cr <= pr - 2 && canBuyNormal(barMap[t]?.[date]?.close ?? Infinity)) {
              const bar = barMap[t]?.[date]; if (!bar || bar.close > cash) continue;
              buy(date, t, bar.close, ranks[t], `11-20상승`);
            }
          }
        }
        for (let k = 0; k < 30; k++) {
          if (cash <= 0) break;
          const cand = top10.filter(t => pos[t] && !blocked(t)).map(t => {
            const bar = barMap[t]?.[date];
            if (!bar || bar.close > cash || !canBuyNormal(bar.close)) return null;
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
  const kStart = kClose[tradeStartIdx], kEnd = kClose[kClose.length - 1]; // 거래기간 KOSPI
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

// ── v5.8 배포본(히스테리시스, fixed KOSPI, 1주씩) 을 base 로 한 개선안 검증 ──
const V58 = mk({ name: 'v5.8배포', rankExit: 'hysteresis', exitRankThreshold: 20, confirmDays: 2 });
const v58 = (over) => ({ ...V58, ...over });

// ❷ 딥 바이 — KOSPI -3% 이하 매수 허용 + 현금 리저브(실탄) + 딥바이 전용 손절
// 핵심: 현금 리저브 없이는 딥바이가 무의미(항상 99% 투자라 살 돈 없음).
const DEEPBUY_CONFIGS = [
  V58, // 리저브 0 — 항상 풀투자 (딥바이 무효)
  v58({ name: 'D0-현금20%만(딥바이無)', cashReservePct: 20 }),
  v58({ name: 'D1-리저브20%+딥바이', cashReservePct: 20, deepBuyTrigger: -3 }),
  v58({ name: 'D2-리저브20%+딥+손절8%', cashReservePct: 20, deepBuyTrigger: -3, deepBuyStopPct: 8 }),
  v58({ name: 'D3-리저브30%+딥+손절8%', cashReservePct: 30, deepBuyTrigger: -3, deepBuyStopPct: 8 }),
  v58({ name: 'D4-리저브20%+딥+addOn', cashReservePct: 20, deepBuyTrigger: -3, deepBuyStopPct: 8, deepBuyAddOn: true }),
];

// ❶ 재매수 쿨다운 — 당일 매도 종목 당일 재매수 금지
const COOLDOWN_CONFIGS = [
  V58,
  v58({ name: 'CD1-재매수쿨다운', rebuyCooldown: true }),
];

// ── 모멘텀 네이티브 개선 (엔진과 싸우지 않는 방향) ──
const FRONTIER_CONFIGS = [
  V58, // 현 배포 (시총선택, 레짐필터 無)
  v58({ name: 'F1-200일선레짐필터', regimeFilter: '200ma' }),
  v58({ name: 'F2-모멘텀선택(120일)', selection: 'momentum', momentumWindow: 120 }),
  v58({ name: 'F3-모멘텀선택(60일)', selection: 'momentum', momentumWindow: 60 }),
  v58({ name: 'F4-모멘텀+레짐필터', selection: 'momentum', momentumWindow: 120, regimeFilter: '200ma' }),
  v58({ name: 'F5-모멘텀+레짐+목표비중', selection: 'momentum', momentumWindow: 120, regimeFilter: '200ma', sizing: 'targetweight', targetPositions: 8 }),
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

// 광범위 검증용 — 다양한 국면 (2018 무역전쟁 하락, 2019 회복, 2021 횡보, 2023 반등, 2024 변동)
const VALIDATE_REGIMES = {
  '2018_trade':   { p1: unix('2018-01-01'), p2: unix('2018-12-31') }, // 무역전쟁, KOSPI -17%
  '2019_recover': { p1: unix('2019-01-01'), p2: unix('2019-12-31') }, // 회복 +8%
  '2020_crash':   { p1: unix('2020-01-01'), p2: unix('2020-12-31') }, // COVID 폭락+V반등
  '2021_side':    { p1: unix('2021-01-01'), p2: unix('2021-12-31') }, // 횡보 +4%
  '2022_bear':    { p1: unix('2022-01-01'), p2: unix('2022-12-31') }, // 하락 -15%
  '2023_rebound': { p1: unix('2023-01-01'), p2: unix('2023-12-31') }, // 반등 +18%
  '2024_volatile':{ p1: unix('2024-01-01'), p2: unix('2024-12-31') }, // 변동 -10%
  '2025_bull':    { p1: unix('2025-06-05'), p2: unix('2026-06-05') }, // 폭등 +200%
};

const wantRegimes = process.argv.includes('--regimes');
const wantDeepbuy = process.argv.includes('--deepbuy');
const wantCooldown = process.argv.includes('--cooldown');
const wantFrontier = process.argv.includes('--frontier');
const wantValidate = process.argv.includes('--validate');

function fmtRow(r) {
  return `${r.cfg.padEnd(22)} ${(r.ret>=0?'+':'')+r.ret.toFixed(1).padStart(6)}%  ` +
    `MDD ${r.mdd.toFixed(1).padStart(5)}%  Sharpe ${r.sharpe.toFixed(2).padStart(5)}  ` +
    `α ${(r.alpha>=0?'+':'')+r.alpha.toFixed(1).padStart(6)}%p  ` +
    `매수 ${String(r.buys).padStart(3)} 매도 ${String(r.sells).padStart(3)} 승률 ${r.winRate.toFixed(0).padStart(3)}%`;
}

console.log('📥 데이터 로드...\n');

// ❷/❶ 개선안 — 3개 레짐 비교 (딥바이는 2020 폭락·2022 하락이 핵심 검증장)
async function runImprovementTest(configs, title, extraAnalysis) {
  for (const [rname, { p1, p2 }] of Object.entries(REGIMES)) {
    const regime = await loadRegime(rname, p1, p2);
    const si = regime.tradeStartIdx ?? 0;
    const kRet = (regime.kospi[regime.kospi.length-1].close - regime.kospi[si].close)/regime.kospi[si].close*100;
    console.log(`\n═══════════ ${title} · ${rname} (종목 ${regime.loaded}, KOSPI ${kRet>=0?'+':''}${kRet.toFixed(1)}%) ═══════════`);
    for (const cfg of configs) {
      const r = simulate(regime, cfg);
      console.log(fmtRow(r));
      if (extraAnalysis) extraAnalysis(r, regime);
    }
  }
}

// 광범위 검증 — v5.8 vs 모멘텀 선택 vs 모멘텀+레짐, 8개 연도 + 요약 통계
async function runValidate() {
  const configs = [
    V58,
    v58({ name: 'F2-모멘텀(120)', selection: 'momentum', momentumWindow: 120 }),
    v58({ name: 'F5-모멘텀+레짐+비중', selection: 'momentum', momentumWindow: 120, regimeFilter: '200ma', sizing: 'targetweight', targetPositions: 8 }),
  ];
  const collected = configs.map(() => []);
  console.log('연도'.padEnd(15), 'KOSPI'.padStart(8), '│', configs.map(c => c.name.padStart(16)).join(' '));
  console.log('─'.repeat(78));
  for (const [rname, { p1, p2 }] of Object.entries(VALIDATE_REGIMES)) {
    const regime = await loadRegime(rname, p1, p2);
    const si = regime.tradeStartIdx ?? 0;
    const kRet = (regime.kospi[regime.kospi.length-1].close - regime.kospi[si].close)/regime.kospi[si].close*100;
    const cells = configs.map((cfg, ci) => {
      const r = simulate(regime, cfg);
      collected[ci].push(r.ret);
      return `${(r.ret>=0?'+':'')+r.ret.toFixed(1)}% (M${r.mdd.toFixed(0)})`.padStart(16);
    });
    console.log(`${rname.padEnd(15)} ${(kRet>=0?'+':'')+kRet.toFixed(1).padStart(6)}%`, '│', cells.join(' '));
  }
  console.log('─'.repeat(78));
  // 요약: 평균, 기하평균(복리), 최저 연도, baseline 대비 승수
  const stats = collected.map((rets) => {
    const avg = rets.reduce((a,b)=>a+b,0)/rets.length;
    const geo = (rets.reduce((a,b)=>a*(1+b/100),1) ** (1/rets.length) - 1) * 100;
    const worst = Math.min(...rets);
    return { avg, geo, worst };
  });
  console.log('산술평균'.padEnd(15), ' '.padStart(8), '│', stats.map(s => `${(s.avg>=0?'+':'')+s.avg.toFixed(1)}%`.padStart(16)).join(' '));
  console.log('기하평균(복리)'.padEnd(13), ' '.padStart(8), '│', stats.map(s => `${(s.geo>=0?'+':'')+s.geo.toFixed(1)}%`.padStart(16)).join(' '));
  console.log('최악연도'.padEnd(15), ' '.padStart(8), '│', stats.map(s => `${(s.worst>=0?'+':'')+s.worst.toFixed(1)}%`.padStart(16)).join(' '));
  // baseline 대비 모멘텀 승률
  const base = collected[0], mom = collected[1];
  const wins = base.filter((b,i) => mom[i] > b).length;
  console.log(`\n모멘텀(F2) vs v5.8: ${wins}/${base.length} 연도 우세, 연평균 차이 ${(stats[1].avg - stats[0].avg).toFixed(1)}%p`);
}

if (wantValidate) {
  await runValidate();
} else if (wantFrontier) {
  await runImprovementTest(FRONTIER_CONFIGS, '모멘텀네이티브');
} else if (wantDeepbuy) {
  await runImprovementTest(DEEPBUY_CONFIGS, '❷딥바이', (r) => {
    const deep = r.trades.filter(t => t.type==='SELL' && (t.reason==='딥손절'));
    const deepBuys = r.trades.filter(t => t.type==='BUY' && t.reason.includes('딥바이'));
    if (deepBuys.length) {
      const dl = deep.reduce((a,t)=>a+t.profit,0);
      console.log(`        딥바이 매수 ${deepBuys.length}건, 딥손절 ${deep.length}건(${Math.round(dl).toLocaleString()}원)`);
    }
  });
} else if (wantCooldown) {
  await runImprovementTest(COOLDOWN_CONFIGS, '❶쿨다운');
} else if (!wantRegimes) {
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
