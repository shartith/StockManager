#!/usr/bin/env node
/**
 * v5.7.0 매매 전략 백테스트 — 자본금 500만원, 1년치 일봉 시뮬레이션.
 *
 * 한계:
 *   - 시총 순위는 종가 × 현재 시총가중치(고정)로 일별 추정 (분할/증자 무시).
 *   - 일봉 단위라 14:30 cron 은 일별 rebalance 와 통합.
 *   - 슬리피지/호가단위 무시 (시장가 = 종가).
 *   - 종목 풀 25개 고정 — 1년 동안 들락날락한 대형주 합집합.
 *   - 트레일링 -2%: 일봉 저가 < 고점 × 0.98 이면 매도(고점 × 0.98 가격에 체결 가정).
 *
 * 매매 시그널 (rebalanceStrategy.ts 와 동일):
 *   S1 트레일링 스톱   — 수익 +10% 도달 → 활성, 고점 -2% 이탈 시 매도
 *   S2 순위 이탈      — 매수 시점 buy_rank 보다 현재 rank > 이면 매도
 *   S3 KOSPI +4% 매도 — 수익 +5% 이상 종목만
 *   B1 시장 브레이크  — KOSPI -2% 이상 하락 또는 5MA<20MA+KOSPI-2% → 매수 차단
 *   B2 미보유 Top 10  — 시총 1위부터 1주씩
 *   B3 11~20위 상승   — 24h 전 대비 2단계+ 상승 종목
 *   B4 재분배         — Top 10 보유 종목 중 평가금액 최저 1주
 *
 * 사용: node scripts/backtest-v5.7.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────
// 1. 종목 풀 — 1년간 Top 20 권에 들었던 대형주 합집합
// ─────────────────────────────────────────────────────────────
// 현재 시총 (억원, 2026-06 기준 근사값) — 일별 순위 산출용 발행주식수 추정에 사용
const STOCK_POOL = [
  { ticker: '005930', name: '삼성전자',         marketCapEok: 4_800_000, suffix: 'KS' },
  { ticker: '000660', name: 'SK하이닉스',       marketCapEok: 1_700_000, suffix: 'KS' },
  { ticker: '373220', name: 'LG에너지솔루션',   marketCapEok: 1_000_000, suffix: 'KS' },
  { ticker: '207940', name: '삼성바이오로직스', marketCapEok:   700_000, suffix: 'KS' },
  { ticker: '005935', name: '삼성전자우',       marketCapEok:   480_000, suffix: 'KS' },
  { ticker: '005380', name: '현대차',           marketCapEok:   500_000, suffix: 'KS' },
  { ticker: '000270', name: '기아',             marketCapEok:   400_000, suffix: 'KS' },
  { ticker: '068270', name: '셀트리온',         marketCapEok:   400_000, suffix: 'KS' },
  { ticker: '005490', name: 'POSCO홀딩스',      marketCapEok:   270_000, suffix: 'KS' },
  { ticker: '035420', name: 'NAVER',            marketCapEok:   340_000, suffix: 'KS' },
  { ticker: '105560', name: 'KB금융',           marketCapEok:   320_000, suffix: 'KS' },
  { ticker: '035720', name: '카카오',           marketCapEok:   220_000, suffix: 'KS' },
  { ticker: '012330', name: '현대모비스',       marketCapEok:   240_000, suffix: 'KS' },
  { ticker: '028260', name: '삼성물산',         marketCapEok:   260_000, suffix: 'KS' },
  { ticker: '055550', name: '신한지주',         marketCapEok:   280_000, suffix: 'KS' },
  { ticker: '086790', name: '하나금융지주',     marketCapEok:   190_000, suffix: 'KS' },
  { ticker: '015760', name: '한국전력',         marketCapEok:   170_000, suffix: 'KS' },
  { ticker: '033780', name: 'KT&G',             marketCapEok:   170_000, suffix: 'KS' },
  { ticker: '051910', name: 'LG화학',           marketCapEok:   220_000, suffix: 'KS' },
  { ticker: '017670', name: 'SK텔레콤',         marketCapEok:   120_000, suffix: 'KS' },
  { ticker: '066570', name: 'LG전자',           marketCapEok:   170_000, suffix: 'KS' },
  { ticker: '329180', name: 'HD현대중공업',     marketCapEok:   330_000, suffix: 'KS' },
  { ticker: '003670', name: '포스코퓨처엠',     marketCapEok:   170_000, suffix: 'KS' },
  { ticker: '096770', name: 'SK이노베이션',     marketCapEok:   140_000, suffix: 'KS' },
  { ticker: '047810', name: '한국항공우주',     marketCapEok:    90_000, suffix: 'KS' },
];

// ─────────────────────────────────────────────────────────────
// 2. Yahoo 일봉 fetch (1년)
// ─────────────────────────────────────────────────────────────

async function fetchDaily(ticker, suffix, range = '1y') {
  const symbol = ticker === '^KS11' ? '^KS11' : `${ticker}.${suffix}`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const data = await res.json();
  const r = data.chart?.result?.[0];
  if (!r) throw new Error(`no data for ${symbol}`);
  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    const open = q.open[i];
    const high = q.high[i];
    const low = q.low[i];
    if (close == null || !Number.isFinite(close)) continue;
    bars.push({
      // YYYY-MM-DD (UTC 자정 기준이라 한국 거래일과 1일 차이 있을 수 있으나 일관성 유지됨)
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: open ?? close,
      close,
      high: high ?? close,
      low: low ?? close,
    });
  }
  return bars;
}

// ─────────────────────────────────────────────────────────────
// 3. 데이터 로드
// ─────────────────────────────────────────────────────────────

console.log('📥 Yahoo Finance 1년치 일봉 로드 중...');
const kospi = await fetchDaily('^KS11', '', '1y');
console.log(`   KOSPI: ${kospi.length} 봉 (${kospi[0].date} ~ ${kospi[kospi.length - 1].date})`);

const stockBars = {}; // ticker → bars[]
const sharesOutstanding = {}; // ticker → 발행주식수 (현재 시총/마지막 종가로 추정, 고정)
const failed = [];
for (const s of STOCK_POOL) {
  try {
    const bars = await fetchDaily(s.ticker, s.suffix, '1y');
    if (bars.length < 50) {
      failed.push(`${s.ticker} ${s.name} (봉 ${bars.length} 부족)`);
      continue;
    }
    stockBars[s.ticker] = bars;
    // 발행주식수 = 현재 시총(억원) × 1e8 / 마지막 종가
    const lastClose = bars[bars.length - 1].close;
    sharesOutstanding[s.ticker] = (s.marketCapEok * 1e8) / lastClose;
  } catch (err) {
    failed.push(`${s.ticker} ${s.name} (${err.message})`);
  }
  await new Promise(r => setTimeout(r, 50)); // rate-limit 회피
}
if (failed.length) console.log(`   ⚠️ 실패: ${failed.join(', ')}`);
console.log(`   주식 종목: ${Object.keys(stockBars).length} 종목 fetch 완료`);

// ─────────────────────────────────────────────────────────────
// 4. 거래일 정렬 (KOSPI 기준 — 휴장일은 KOSPI 봉이 없으므로 자동 skip)
// ─────────────────────────────────────────────────────────────

const tradingDays = kospi.map(b => b.date);
const tickers = Object.keys(stockBars);

// 종목별 date → bar 맵으로 변환 (빠른 조회)
const barMap = {};
for (const t of tickers) {
  barMap[t] = {};
  for (const b of stockBars[t]) barMap[t][b.date] = b;
}
const kospiMap = {};
for (const b of kospi) kospiMap[b.date] = b;

// ─────────────────────────────────────────────────────────────
// 5. 일별 시총 순위 산출
// ─────────────────────────────────────────────────────────────

function computeRanks(date) {
  const list = [];
  for (const t of tickers) {
    const b = barMap[t][date];
    if (!b) continue;
    const mc = b.close * sharesOutstanding[t];
    list.push({ ticker: t, marketCap: mc, close: b.close });
  }
  list.sort((a, b) => b.marketCap - a.marketCap);
  const ranks = {};
  list.forEach((s, i) => { ranks[s.ticker] = i + 1; });
  return { ranks, sorted: list };
}

// ─────────────────────────────────────────────────────────────
// 6. 시뮬레이터
// ─────────────────────────────────────────────────────────────

const FEE_RATE = 0.00015; // 0.015%
const INIT_CAPITAL = 5_000_000;

// 임계값 — rebalanceStrategy.ts 와 동일
const TRAIL_ACTIVATE = 10;
const TRAIL_DROP = 2;
const KOSPI_SELL_TRIGGER = 4;
const KOSPI_SELL_PROFIT_MIN = 5;
const KOSPI_BUY_TRIGGER = -4;
const RANK_IMPROVE_HOURS = 24;     // 백테스트에서는 "전일 대비"로 단순화
const RANK_IMPROVE_THRESHOLD = 2;

// 상태
let cash = INIT_CAPITAL;
const positions = {}; // ticker → { qty, totalCost, buyRank, highestPrice, trailingActive }
const tradeLog = [];   // { date, ticker, type, qty, price, reason, profit }
const portfolioHistory = []; // { date, totalValue, cash, holdingValue, kospi }
const rankHistory = {}; // date → ranks

// 매수
function buy(date, ticker, name, price, rank, reason) {
  if (cash < price) return false;
  const fee = price * FEE_RATE;
  const cost = price + fee;
  if (cash < cost) return false;
  cash -= cost;
  const pos = positions[ticker] ?? { qty: 0, totalCost: 0, buyRank: rank, highestPrice: price, trailingActive: false };
  pos.qty += 1;
  pos.totalCost += cost;
  pos.buyRank = rank; // 재매수 시 갱신
  pos.highestPrice = Math.max(pos.highestPrice, price);
  positions[ticker] = pos;
  tradeLog.push({ date, ticker, name, type: 'BUY', qty: 1, price, reason });
  return true;
}

// 매도 (전량)
function sellAll(date, ticker, name, price, reason) {
  const pos = positions[ticker];
  if (!pos || pos.qty <= 0) return;
  const gross = price * pos.qty;
  const fee = gross * FEE_RATE;
  const net = gross - fee;
  const profit = net - pos.totalCost;
  const profitPct = pos.totalCost > 0 ? (profit / pos.totalCost) * 100 : 0;
  cash += net;
  tradeLog.push({
    date, ticker, name, type: 'SELL', qty: pos.qty, price, reason,
    profit: Math.round(profit), profitPct: Math.round(profitPct * 100) / 100,
  });
  delete positions[ticker];
}

// KOSPI 5일/20일 이동평균 (시뮬 기준 — 과거 N봉 평균)
function kospiMA(dayIdx, window) {
  if (dayIdx < window - 1) return null;
  let sum = 0;
  for (let i = dayIdx - window + 1; i <= dayIdx; i++) sum += kospi[i].close;
  return sum / window;
}

// KOSPI 일변동률
function kospiChange(dayIdx) {
  if (dayIdx === 0) return 0;
  return ((kospi[dayIdx].close - kospi[dayIdx - 1].close) / kospi[dayIdx - 1].close) * 100;
}

console.log(`\n🔄 백테스트 시작 (자본금 ${INIT_CAPITAL.toLocaleString()}원, ${tradingDays.length} 거래일)\n`);

for (let i = 0; i < tradingDays.length; i++) {
  const date = tradingDays[i];
  const kChange = kospiChange(i);
  const ma5 = kospiMA(i, 5);
  const ma20 = kospiMA(i, 20);
  const { ranks } = computeRanks(date);
  rankHistory[date] = ranks;

  // 종목명 lookup
  const nameOf = (t) => STOCK_POOL.find(s => s.ticker === t)?.name ?? t;

  // ───── Phase 1: 매도 평가 ─────
  // 각 보유 종목별 일봉 high/low 로 트레일링 갱신, 시그널 발화 시 매도
  const heldTickers = Object.keys(positions);
  for (const t of heldTickers) {
    const bar = barMap[t]?.[date];
    if (!bar) continue;
    const pos = positions[t];
    const avgPrice = pos.totalCost / pos.qty;
    // 일봉 high 로 최고가 갱신
    pos.highestPrice = Math.max(pos.highestPrice, bar.high);
    // 수익률 (종가 기준 평가)
    const profitPct = ((bar.close - avgPrice) / avgPrice) * 100;
    // 트레일링 활성화
    if (!pos.trailingActive && profitPct >= TRAIL_ACTIVATE) {
      pos.trailingActive = true;
    }
    // S1 트레일링 스톱 — 일봉 저가가 고점 × (1 - drop/100) 이하면 그 가격에 체결 가정
    if (pos.trailingActive) {
      const trailPrice = pos.highestPrice * (1 - TRAIL_DROP / 100);
      if (bar.low <= trailPrice) {
        sellAll(date, t, nameOf(t), trailPrice, `트레일링 -${TRAIL_DROP}% (고점 ${Math.round(pos.highestPrice)})`);
        continue;
      }
    }
    // S2 순위 이탈 — buy_rank 보다 현재 rank 가 떨어졌으면 매도 (종가에 체결)
    const currentRank = ranks[t] ?? 999;
    if (currentRank > pos.buyRank) {
      sellAll(date, t, nameOf(t), bar.close, `순위 이탈 (매수 ${pos.buyRank}위 → ${currentRank}위)`);
      continue;
    }
    // S3 KOSPI +4% + 수익 +5%
    if (kChange >= KOSPI_SELL_TRIGGER && profitPct >= KOSPI_SELL_PROFIT_MIN) {
      sellAll(date, t, nameOf(t), bar.close, `KOSPI +${kChange.toFixed(2)}% + 수익 +${profitPct.toFixed(2)}%`);
      continue;
    }
  }

  // ───── Phase 2: 매수 평가 ─────
  // 시장 브레이크: KOSPI -2% 이상 하락
  const marketBrake = kChange <= -2;
  // 죽는 시장: 5MA < 20MA + KOSPI -2%
  const dying = (ma5 !== null && ma20 !== null && ma5 < ma20 && kChange <= -2);
  if (!marketBrake && !dying) {
    // B2 미보유 Top 10 — 시총 1위부터
    const sorted = Object.entries(ranks).sort((a, b) => a[1] - b[1]);
    const top10Tickers = sorted.slice(0, 10).map(([t]) => t);
    const top20Tickers = sorted.slice(0, 20).map(([t]) => t);

    for (const t of top10Tickers) {
      if (positions[t]) continue;
      const bar = barMap[t]?.[date];
      if (!bar) continue;
      if (bar.close > cash) continue;
      buy(date, t, nameOf(t), bar.close, ranks[t], `Top10 #${ranks[t]} 신규 진입`);
    }

    // B3 11~20위 상승 추세 — 전일 대비 2단계+ 상승
    if (i > 0) {
      const prevRanks = rankHistory[tradingDays[i - 1]] ?? {};
      for (const t of top20Tickers.slice(10)) {
        if (positions[t]) continue;
        const prev = prevRanks[t] ?? 999;
        const curr = ranks[t];
        if (curr <= prev - RANK_IMPROVE_THRESHOLD) {
          const bar = barMap[t]?.[date];
          if (!bar || bar.close > cash) continue;
          buy(date, t, nameOf(t), bar.close, ranks[t], `#${ranks[t]} 상승 (전일 ${prev}위→${curr}위)`);
        }
      }
    }

    // B4 재분배 — Top 10 보유 종목 중 평가금액 최저 1주, 잔고 가능할 때까지
    for (let iter = 0; iter < 30; iter++) {
      if (cash <= 0) break;
      const top10Held = top10Tickers
        .filter(t => positions[t])
        .map(t => {
          const bar = barMap[t]?.[date];
          if (!bar || bar.close > cash) return null;
          return { ticker: t, close: bar.close, evalAmt: positions[t].qty * bar.close };
        })
        .filter(Boolean)
        .sort((a, b) => a.evalAmt - b.evalAmt);
      if (top10Held.length === 0) break;
      const tgt = top10Held[0];
      if (!buy(date, tgt.ticker, nameOf(tgt.ticker), tgt.close, ranks[tgt.ticker], '재분배')) break;
    }
  }

  // ───── 일별 포트폴리오 가치 기록 ─────
  // 그 날 일봉이 누락된 종목은 직전 영업일 종가로 평가(거래정지/Yahoo 데이터 결손 대응)
  let holdingValue = 0;
  for (const t of Object.keys(positions)) {
    let priceForEval = null;
    for (let j = i; j >= 0; j--) {
      const b = barMap[t]?.[tradingDays[j]];
      if (b) { priceForEval = b.close; break; }
    }
    if (priceForEval === null) priceForEval = positions[t].totalCost / positions[t].qty; // 폴백: 평단
    holdingValue += positions[t].qty * priceForEval;
  }
  portfolioHistory.push({
    date,
    cash: Math.round(cash),
    holdingValue: Math.round(holdingValue),
    totalValue: Math.round(cash + holdingValue),
    kospi: kospi[i].close,
    kChange: Math.round(kChange * 100) / 100,
  });
}

// ─────────────────────────────────────────────────────────────
// 7. 결과 분석
// ─────────────────────────────────────────────────────────────

const finalValue = portfolioHistory[portfolioHistory.length - 1].totalValue;
const totalReturn = ((finalValue - INIT_CAPITAL) / INIT_CAPITAL) * 100;
const days = portfolioHistory.length;

// MDD 계산
let peak = INIT_CAPITAL;
let mdd = 0;
let mddDate = '';
for (const p of portfolioHistory) {
  if (p.totalValue > peak) peak = p.totalValue;
  const dd = ((peak - p.totalValue) / peak) * 100;
  if (dd > mdd) { mdd = dd; mddDate = p.date; }
}

// KOSPI vs 전략
const kospiStart = kospi[0].close;
const kospiEnd = kospi[kospi.length - 1].close;
const kospiReturn = ((kospiEnd - kospiStart) / kospiStart) * 100;

// 매매 통계
const buys = tradeLog.filter(t => t.type === 'BUY').length;
const sells = tradeLog.filter(t => t.type === 'SELL');
const wins = sells.filter(t => (t.profit ?? 0) > 0);
const losses = sells.filter(t => (t.profit ?? 0) <= 0);
const winRate = sells.length > 0 ? (wins.length / sells.length) * 100 : 0;
const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : 0;
const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.profit, 0) / losses.length : 0;
const totalProfit = sells.reduce((s, t) => s + (t.profit ?? 0), 0);

// 매도 사유별 카운트
const sellReasonCounts = {};
for (const t of sells) {
  const key = t.reason.split('—')[0].split('(')[0].trim();
  sellReasonCounts[key] = (sellReasonCounts[key] ?? 0) + 1;
}

// ─────────────────────────────────────────────────────────────
// 8. 리포트 출력 + CSV 저장
// ─────────────────────────────────────────────────────────────

const outDir = path.resolve('docs', 'backtest-v5.7');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

writeFileSync(path.join(outDir, 'portfolio_daily.csv'),
  'date,total,cash,holdings,kospi,kospi_chg_pct\n' +
  portfolioHistory.map(p => `${p.date},${p.totalValue},${p.cash},${p.holdingValue},${p.kospi},${p.kChange}`).join('\n'),
);
writeFileSync(path.join(outDir, 'trades.csv'),
  'date,ticker,name,type,qty,price,reason,profit,profit_pct\n' +
  tradeLog.map(t => `${t.date},${t.ticker},${t.name},${t.type},${t.qty},${Math.round(t.price)},"${t.reason}",${t.profit ?? ''},${t.profitPct ?? ''}`).join('\n'),
);

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  v5.7.0 백테스트 결과');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  기간            : ${tradingDays[0]} ~ ${tradingDays[tradingDays.length-1]} (${days} 거래일)`);
console.log(`  자본금          : ${INIT_CAPITAL.toLocaleString()}원`);
console.log(`  최종 평가가치   : ${finalValue.toLocaleString()}원`);
console.log(`  총 수익률       : ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%  (${Math.round(finalValue - INIT_CAPITAL).toLocaleString()}원)`);
console.log(`  연환산 수익률   : ${(totalReturn * (252 / days)).toFixed(2)}%  (단순 환산)`);
console.log(`  최대 낙폭 (MDD) : -${mdd.toFixed(2)}%  (${mddDate})`);
console.log(`  vs KOSPI 인덱스 : KOSPI ${kospiReturn >= 0 ? '+' : ''}${kospiReturn.toFixed(2)}%  → 초과수익 ${(totalReturn - kospiReturn) >= 0 ? '+' : ''}${(totalReturn - kospiReturn).toFixed(2)}%p`);
console.log('───────────────────────────────────────────────────────────');
console.log(`  매수 횟수       : ${buys}건`);
console.log(`  매도 횟수       : ${sells.length}건`);
console.log(`  승률            : ${winRate.toFixed(1)}%  (${wins.length}/${sells.length})`);
console.log(`  평균 이익       : +${Math.round(avgWin).toLocaleString()}원`);
console.log(`  평균 손실       : ${Math.round(avgLoss).toLocaleString()}원`);
console.log(`  실현 손익 합    : ${totalProfit >= 0 ? '+' : ''}${Math.round(totalProfit).toLocaleString()}원`);
console.log('───────────────────────────────────────────────────────────');
console.log('  매도 사유별:');
for (const [k, v] of Object.entries(sellReasonCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(30)} ${v}건`);
}
console.log('───────────────────────────────────────────────────────────');
console.log(`  CSV 저장: ${outDir}/portfolio_daily.csv, trades.csv`);
console.log('═══════════════════════════════════════════════════════════');
