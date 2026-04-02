/**
 * 전략 내보내기/가져오기 + LoRA 학습 데이터 생성
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSettings, saveSettings } from './settings';
import { loadWeights, saveWeights } from './weightOptimizer';
import { getPerformanceSummary } from './performanceTracker';
import { queryAll } from '../db';

const DATA_DIR = process.env.STOCK_MANAGER_DATA || path.join(require('os').homedir(), '.stock-manager');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

function ensureExportDir() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

// ─── 전략 내보내기 ─────────────────────────────────────

export function exportStrategy(): { filePath: string; summary: string } {
  ensureExportDir();
  const settings = getSettings();
  const weights = loadWeights();
  const performance = getPerformanceSummary(undefined, 90);

  // 가중치 변경 이력
  const weightHistory = queryAll(
    'SELECT score_type, old_weight, new_weight, correlation, sample_size, created_at FROM weight_optimization_log ORDER BY created_at DESC LIMIT 10'
  );

  const strategy = {
    version: '2.0',
    exportedAt: new Date().toISOString(),
    metadata: {
      format: 'stock-manager-strategy-v1',
      dataDir: DATA_DIR,
    },

    // 설정 (credentials 제외)
    settings: {
      investmentStyle: settings.investmentStyle,
      debateMode: settings.debateMode,
      stopLossPercent: settings.stopLossPercent,
      ollamaModel: settings.ollamaModel,
      autoTradeEnabled: settings.autoTradeEnabled,
      autoTradeMaxInvestment: settings.autoTradeMaxInvestment,
      autoTradeMaxPerStock: settings.autoTradeMaxPerStock,
      autoTradeMaxDailyTrades: settings.autoTradeMaxDailyTrades,
      scheduleKrx: settings.scheduleKrx,
      scheduleNyse: settings.scheduleNyse,
    },

    // 스코어링 가중치
    weights,

    // 성과 요약
    performance,

    // 가중치 변경 이력
    weightHistory: weightHistory.map((w: any) => ({
      scoreType: w.score_type,
      oldWeight: w.old_weight,
      newWeight: w.new_weight,
      correlation: w.correlation,
      sampleSize: w.sample_size,
      date: w.created_at,
    })),
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(EXPORT_DIR, `strategy-${timestamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(strategy, null, 2), 'utf-8');

  const summary = `전략 내보내기 완료: ${filePath}\n` +
    `  투자 스타일: ${settings.investmentStyle}\n` +
    `  토론 모드: ${settings.debateMode ? 'ON' : 'OFF'}\n` +
    `  승률(7일): ${performance.buyWinRate7d ?? 'N/A'}%\n` +
    `  총 신호: ${performance.totalSignals}건`;

  return { filePath, summary };
}

// ─── 전략 가져오기 ─────────────────────────────────────

export function importStrategy(filePath: string): { success: boolean; message: string } {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: `파일을 찾을 수 없습니다: ${filePath}` };
  }

  let strategy: any;
  try {
    strategy = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { success: false, message: 'JSON 파싱 실패 — 올바른 전략 파일인지 확인하세요' };
  }

  // 스키마 검증
  if (!strategy.version || !strategy.settings || !strategy.weights) {
    return { success: false, message: '전략 파일 형식이 올바르지 않습니다 (version, settings, weights 필요)' };
  }

  // 가중치 범위 검증
  for (const [key, val] of Object.entries(strategy.weights)) {
    const v = val as number;
    if (v < 0.25 || v > 2.0) {
      return { success: false, message: `가중치 범위 초과: ${key}=${v} (0.25~2.0)` };
    }
  }

  // 현재 설정 백업
  ensureExportDir();
  const backupPath = path.join(EXPORT_DIR, `backup-before-import-${Date.now()}.json`);
  const currentSettings = getSettings();
  const currentWeights = loadWeights();
  fs.writeFileSync(backupPath, JSON.stringify({ settings: currentSettings, weights: currentWeights }, null, 2));

  // 설정 적용 (credentials는 보존)
  const s = strategy.settings;
  saveSettings({
    investmentStyle: s.investmentStyle || currentSettings.investmentStyle,
    debateMode: s.debateMode ?? currentSettings.debateMode,
    stopLossPercent: s.stopLossPercent || currentSettings.stopLossPercent,
    autoTradeEnabled: s.autoTradeEnabled ?? currentSettings.autoTradeEnabled,
    autoTradeMaxInvestment: s.autoTradeMaxInvestment || currentSettings.autoTradeMaxInvestment,
    autoTradeMaxPerStock: s.autoTradeMaxPerStock || currentSettings.autoTradeMaxPerStock,
    autoTradeMaxDailyTrades: s.autoTradeMaxDailyTrades || currentSettings.autoTradeMaxDailyTrades,
    ...(s.scheduleKrx ? { scheduleKrx: s.scheduleKrx } : {}),
    ...(s.scheduleNyse ? { scheduleNyse: s.scheduleNyse } : {}),
  });

  // 가중치 적용
  saveWeights(strategy.weights);

  return {
    success: true,
    message: `전략 가져오기 완료\n` +
      `  백업: ${backupPath}\n` +
      `  투자 스타일: ${s.investmentStyle || 'unchanged'}\n` +
      `  가중치 ${Object.keys(strategy.weights).length}개 적용`,
  };
}

// ─── 전체 설정 백업/복원 (API 키 포함) ────────────────────

export function exportFullConfig(): { filePath: string; message: string } {
  ensureExportDir();
  const settings = getSettings();
  const weights = loadWeights();

  const config = {
    version: '2.0',
    type: 'full-config',
    exportedAt: new Date().toISOString(),
    settings, // API 키 포함
    weights,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(EXPORT_DIR, `full-config-${timestamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

  return { filePath, message: `전체 설정 백업 완료 (API 키 포함): ${filePath}\n  ⚠️ 이 파일에는 민감한 정보가 포함되어 있습니다. 안전하게 보관하세요.` };
}

export function importFullConfig(filePath: string): { success: boolean; message: string } {
  if (!fs.existsSync(filePath)) {
    return { success: false, message: `파일을 찾을 수 없습니다: ${filePath}` };
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { success: false, message: 'JSON 파싱 실패' };
  }

  if (!config.settings) {
    return { success: false, message: '설정 데이터가 없습니다' };
  }

  // 현재 설정 백업
  ensureExportDir();
  const backupPath = path.join(EXPORT_DIR, `backup-full-${Date.now()}.json`);
  const current = getSettings();
  fs.writeFileSync(backupPath, JSON.stringify({ settings: current, weights: loadWeights() }, null, 2));

  // 전체 설정 덮어쓰기 (API 키 포함)
  saveSettings(config.settings);
  if (config.weights) saveWeights(config.weights);

  return {
    success: true,
    message: `전체 설정 복원 완료\n  백업: ${backupPath}\n  KIS API: ${config.settings.kisAppKey ? '포함' : '미포함'}\n  DART API: ${config.settings.dartApiKey ? '포함' : '미포함'}\n  가중치: ${config.weights ? Object.keys(config.weights).length + '개' : '미포함'}`,
  };
}

// ─── LoRA 학습 데이터 생성 ──────────────────────────────

const LORA_MIN_SAMPLES = 5000;

export function getLoraDataCount(): number {
  const row = queryAll(
    "SELECT COUNT(*) as cnt FROM signal_performance WHERE return_7d IS NOT NULL"
  );
  return row[0]?.cnt || 0;
}

export function generateLoraDataset(): { filePath: string | null; count: number; message: string } {
  const count = getLoraDataCount();

  if (count < LORA_MIN_SAMPLES) {
    return {
      filePath: null,
      count,
      message: `LoRA 학습 데이터 부족: ${count}/${LORA_MIN_SAMPLES}건 (${Math.round(count / LORA_MIN_SAMPLES * 100)}%)`,
    };
  }

  ensureExportDir();

  // signal_performance + trade_signals JOIN
  const records = queryAll(`
    SELECT
      sp.ticker, sp.market, sp.signal_type, sp.signal_confidence,
      sp.signal_price, sp.target_price, sp.stop_loss_price,
      sp.price_7d, sp.price_14d, sp.price_30d,
      sp.return_7d, sp.return_14d, sp.return_30d,
      sp.target_hit, sp.stop_loss_hit,
      sp.key_factors_json, sp.created_at,
      ts.indicators_json, ts.llm_reasoning, ts.confidence
    FROM signal_performance sp
    JOIN trade_signals ts ON ts.id = sp.signal_id
    WHERE sp.return_7d IS NOT NULL
    ORDER BY sp.created_at DESC
  `);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(EXPORT_DIR, `lora-dataset-${timestamp}.jsonl`);

  const lines: string[] = [];
  for (const r of records) {
    // indicators_json에서 기술적 지표 추출
    let indicators: any = {};
    try { indicators = JSON.parse(r.indicators_json || '{}'); } catch {}

    const ind = indicators.indicators || {};
    const vol = indicators.volumeAnalysis || {};

    // 입력 텍스트 구성
    const inputParts: string[] = [];
    if (ind.rsi14) inputParts.push(`RSI:${ind.rsi14}`);
    if (ind.macdHistogram > 0) inputParts.push('MACD:골든크로스');
    else if (ind.macdHistogram < 0) inputParts.push('MACD:데드크로스');
    if (ind.technicalSignal) inputParts.push(`기술신호:${ind.technicalSignal}`);
    if (vol.todayVsAvg) inputParts.push(`거래량:${vol.todayVsAvg.toFixed(1)}배`);
    inputParts.push(`가격:${r.signal_price}`);

    // 핵심 팩터
    let keyFactors: string[] = [];
    try { keyFactors = JSON.parse(r.key_factors_json || '[]'); } catch {}

    const win7d = r.return_7d > 0;

    const record = {
      instruction: '다음 주식 지표를 분석하여 매매 판단(BUY/SELL/HOLD)과 신뢰도(0-100)를 결정하세요.',
      input: `종목:${r.ticker} 시장:${r.market} ${inputParts.join(' ')}${keyFactors.length > 0 ? ' 팩터:' + keyFactors.join(',') : ''}`,
      output: `signal:${r.signal_type} confidence:${r.signal_confidence} reasoning:${(r.llm_reasoning || '').slice(0, 200)}`,
      outcome: {
        return_7d: r.return_7d,
        return_14d: r.return_14d,
        return_30d: r.return_30d,
        target_hit: !!r.target_hit,
        stop_loss_hit: !!r.stop_loss_hit,
        win: win7d,
      },
    };

    lines.push(JSON.stringify(record));
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  return {
    filePath,
    count: lines.length,
    message: `LoRA 학습 데이터 생성 완료: ${filePath}\n  ${lines.length}건 (승률 ${Math.round(lines.filter(l => JSON.parse(l).outcome.win).length / lines.length * 100)}%)`,
  };
}
