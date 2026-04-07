/**
 * systemEvent.ts — getAiAdvice coverage (uncovered lines 30, 47-51)
 *
 * The existing systemEvent.test.ts runs with Ollama disabled so it never
 * exercises the AI advice branch. Here we enable Ollama and stub `fetch` to
 * hit the HTTP paths inside logSystemEvent.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    ollamaEnabled: true,
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen3:4b',
  })),
}));

import { initializeDB, execute } from '../db';
import { logSystemEvent, getRecentEvents } from '../services/systemEvent';

describe('logSystemEvent — AI advice path', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    execute('DELETE FROM system_events');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends AI advice to detail when severity is WARN and Ollama responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '   즉시 KIS 토큰을 재발급하고 재시도 간격을 늘리세요.   ' }),
    }));

    await logSystemEvent('WARN', 'KIS_API_ERROR', 'token expired', 'original detail', 'SAMSUNG');
    const rows = getRecentEvents(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toContain('original detail');
    expect(rows[0].detail).toContain('[AI 조언]');
    expect(rows[0].detail).toContain('KIS 토큰을 재발급');
  });

  it('skips AI advice on INFO severity (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await logSystemEvent('INFO', 'GENERAL', 'benign', 'nothing wrong');
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = getRecentEvents(1);
    expect(rows[0].detail).toBe('nothing wrong'); // no [AI 조언] block
  });

  it('gracefully handles non-OK Ollama response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await logSystemEvent('ERROR', 'OLLAMA_DOWN', 'LLM down', 'fetch failed');
    const rows = getRecentEvents(1);
    expect(rows[0].detail).toBe('fetch failed'); // no advice appended
  });

  it('gracefully handles Ollama network exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await logSystemEvent('CRITICAL', 'KIS_API_ERROR', 'api down', 'boom');
    const rows = getRecentEvents(1);
    expect(rows[0].detail).toBe('boom'); // swallowed via try/catch
  });

  it('handles empty Ollama response without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));

    await logSystemEvent('WARN', 'GENERAL', 'minor', 'ok');
    const rows = getRecentEvents(1);
    // Empty advice → fullDetail === detail (no [AI 조언] appended)
    expect(rows[0].detail).toBe('ok');
  });
});
