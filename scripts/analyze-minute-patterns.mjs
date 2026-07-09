#!/usr/bin/env node
/**
 * v6.1.4 리서치용 일회성 스크립트 — Naver 비공식 1분봉(fchart.stock.naver.com)으로
 * 최근 6거래일 급등일의 장중 반응 패턴을 분석해 MORNING_CONFIRM_SAMPLES /
 * MORNING_MIN_RISE_PCT / SPIKE_BUY_THRESHOLD_PCT / SPIKE_BUY_MAX_PCT 근거를 마련한다.
 *
 * 제약(확인됨): KIS 는 당일 분봉만 제공하고 웹소켓도 없음. 야후 백테스트 하네스는
 * 일봉만 있음. Naver fchart 는 count 를 얼마로 줘도 최근 6거래일로 캡되고, 시가/고가/
 * 저가는 null — 종가·거래량만 사용 가능. 앱 코드가 아니라 순수 리서치 스크립트이므로
 * server/ 빌드에 포함되지 않는다.
 *
 * 실행: node scripts/analyze-minute-patterns.mjs
 */

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

// 앱의 rebalanceStrategy.ts 상수와 동일 — 여기서 검증 대상
const CONFIRM_SAMPLES = 5;
const MIN_RISE_PCT = 1.5;
const DAY_SPIKE_THRESHOLD = 3; // 이 이상 오른 날만 "급등일"로 취급해 분석

async function fetchTopUniverse(limit = 25) {
  const markets = ['KOSPI', 'KOSDAQ'];
  const all = [];
  for (const market of markets) {
    const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?pageSize=30&page=1`;
    const res = await fetch(url, { headers: { 'User-Agent': UA_MOBILE, Accept: 'application/json' } });
    const json = await res.json();
    for (const s of json.stocks || []) {
      if (s.itemCode && s.stockName) all.push({ ticker: s.itemCode, name: s.stockName, market });
    }
  }
  return all.slice(0, limit);
}

async function fetchMinuteSeries(ticker) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${ticker}&timeframe=minute&count=3000&requestType=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  // data="YYYYMMDDHHmm|open|high|low|close|volume" — open/high/low는 null로 관측됨, close/volume만 사용
  const items = [...text.matchAll(/data="(\d{12})\|[^|]*\|[^|]*\|[^|]*\|(\d+)\|(\d+)"/g)].map((m) => ({
    ts: m[1],
    date: m[1].slice(0, 8),
    hhmm: m[1].slice(8, 12),
    close: Number(m[2]),
  }));
  return items;
}

function groupByDate(items) {
  const byDate = new Map();
  for (const it of items) {
    if (!byDate.has(it.date)) byDate.set(it.date, []);
    byDate.get(it.date).push(it);
  }
  for (const arr of byDate.values()) arr.sort((a, b) => a.hhmm.localeCompare(b.hhmm));
  return byDate;
}

function isSteadyRiser(window) {
  if (window.length < CONFIRM_SAMPLES) return false;
  const recent = window.slice(-CONFIRM_SAMPLES);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] < recent[i - 1]) return false;
  }
  return recent[recent.length - 1] - recent[0] >= MIN_RISE_PCT;
}

function analyzeTicker(ticker, name, byDate) {
  const dates = [...byDate.keys()].sort();
  const results = [];
  for (let d = 1; d < dates.length; d++) {
    const prevDay = byDate.get(dates[d - 1]);
    const today = byDate.get(dates[d]);
    if (!prevDay.length || !today.length) continue;
    const prevClose = prevDay[prevDay.length - 1].close;
    if (prevClose <= 0) continue;

    // 앱의 fluctuationsRatio 와 동일 정의: 전일 종가 대비 각 분 종가 등락률(%)
    const flucts = today.map((m) => ((m.close - prevClose) / prevClose) * 100);
    const dayChange = flucts[flucts.length - 1];
    if (dayChange < DAY_SPIKE_THRESHOLD) continue; // 급등일만 분석

    let confirmIdx = -1;
    for (let i = CONFIRM_SAMPLES; i <= flucts.length; i++) {
      if (isSteadyRiser(flucts.slice(0, i))) {
        confirmIdx = i - 1;
        break;
      }
    }
    const peakVal = Math.max(...flucts);
    const peakIdx = flucts.indexOf(peakVal);

    let afterConfirmGain = null;
    let afterConfirmDrawdown = null;
    if (confirmIdx >= 0) {
      const after = flucts.slice(confirmIdx);
      afterConfirmGain = Math.max(...after) - flucts[confirmIdx];
      afterConfirmDrawdown = flucts[confirmIdx] - Math.min(...after);
    }

    results.push({
      ticker,
      name,
      date: dates[d],
      dayChangePct: +dayChange.toFixed(2),
      peakPct: +peakVal.toFixed(2),
      peakAtMin: today[peakIdx]?.hhmm ?? null,
      confirmed: confirmIdx >= 0,
      confirmAtMin: confirmIdx >= 0 ? today[confirmIdx].hhmm : null,
      confirmPct: confirmIdx >= 0 ? +flucts[confirmIdx].toFixed(2) : null,
      afterConfirmGainPct: afterConfirmGain !== null ? +afterConfirmGain.toFixed(2) : null,
      afterConfirmDrawdownPct: afterConfirmDrawdown !== null ? +afterConfirmDrawdown.toFixed(2) : null,
    });
  }
  return results;
}

async function main() {
  console.error('[1/3] Top 종목 유니버스 조회...');
  const universe = await fetchTopUniverse(25);
  console.error(`  ${universe.length}개 종목: ${universe.map((s) => s.name).join(', ')}`);

  console.error('[2/3] 종목별 1분봉(최근 6거래일) 조회 및 분석...');
  const all = [];
  for (const s of universe) {
    try {
      const items = await fetchMinuteSeries(s.ticker);
      const byDate = groupByDate(items);
      const r = analyzeTicker(s.ticker, s.name, byDate);
      all.push(...r);
      if (r.length) console.error(`  ${s.name}(${s.ticker}): 급등일 ${r.length}건`);
      await new Promise((res) => setTimeout(res, 200)); // 비공식 API 예의상 딜레이
    } catch (err) {
      console.error(`  ${s.ticker} 실패: ${err.message}`);
    }
  }

  console.error(`[3/3] 급등일 총 ${all.length}건 분석 완료.\n`);

  // ── 요약 통계 ──
  const confirmed = all.filter((r) => r.confirmed);
  const unconfirmed = all.filter((r) => !r.confirmed);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const fmt = (n) => (n === null ? 'N/A' : n.toFixed(2));

  console.log('='.repeat(60));
  console.log(`급등일(전일比 +${DAY_SPIKE_THRESHOLD}% 이상) 총 ${all.length}건 중`);
  console.log(`  현재 로직(연속 ${CONFIRM_SAMPLES}분 상승 + ${MIN_RISE_PCT}%+)으로 확인됨: ${confirmed.length}건 (${((confirmed.length / (all.length || 1)) * 100).toFixed(1)}%)`);
  console.log(`  확인 안 됨(놓침): ${unconfirmed.length}건`);
  console.log('');
  console.log(`[확인된 케이스 — 확인 시점 이후 흐름]`);
  console.log(`  확인 시점 등락률 평균: ${fmt(avg(confirmed.map((r) => r.confirmPct)))}%`);
  console.log(`  확인 후 추가 상승폭 평균: ${fmt(avg(confirmed.map((r) => r.afterConfirmGainPct)))}%`);
  console.log(`  확인 후 최대 되돌림(하락) 평균: ${fmt(avg(confirmed.map((r) => r.afterConfirmDrawdownPct)))}%`);
  console.log(`  당일 최종 등락률 평균: ${fmt(avg(confirmed.map((r) => r.dayChangePct)))}%`);
  console.log(`  당일 고점(peak) 평균: ${fmt(avg(confirmed.map((r) => r.peakPct)))}%`);
  console.log('');
  console.log(`[놓친 케이스 — 왜 확인 로직이 못 잡았는지 참고용]`);
  console.log(`  당일 최종 등락률 평균: ${fmt(avg(unconfirmed.map((r) => r.dayChangePct)))}%`);
  console.log('='.repeat(60));
  console.log('\n상세 데이터(JSON):');
  console.log(JSON.stringify(all, null, 2));
}

main().catch((err) => {
  console.error('스크립트 실패:', err);
  process.exit(1);
});
