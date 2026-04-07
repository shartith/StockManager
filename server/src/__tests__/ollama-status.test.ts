/**
 * ollama.ts — checkOllamaStatus coverage (was not tested by the existing
 * callOllama resilience suite)
 *
 * Covers:
 *   - connected:true + model list parsed
 *   - connected:false on HTTP failure
 *   - connected:false on network exception
 *   - empty model list when upstream response omits models
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(() => null),
  execute: vi.fn(),
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen3:4b',
    ollamaEnabled: true,
    debateMode: false,
    investmentStyle: 'balanced',
  })),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('checkOllamaStatus', () => {
  let checkOllamaStatus: typeof import('../services/ollama').checkOllamaStatus;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../db', () => ({
      queryAll: vi.fn(() => []),
      queryOne: vi.fn(() => null),
      execute: vi.fn(),
    }));
    vi.doMock('../services/settings', () => ({
      getSettings: vi.fn(() => ({
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'qwen3:4b',
        ollamaEnabled: true,
      })),
    }));
    vi.doMock('../logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await import('../services/ollama');
    checkOllamaStatus = mod.checkOllamaStatus;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns connected:true with parsed model list', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen3:4b' },
          { name: 'exaone3.5:7.8b' },
          { name: 'llama3:8b' },
        ],
      }),
    });

    const status = await checkOllamaStatus();
    expect(status.connected).toBe(true);
    expect(status.models).toEqual(['qwen3:4b', 'exaone3.5:7.8b', 'llama3:8b']);
  });

  it('returns connected:false and empty list on non-OK HTTP response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    const status = await checkOllamaStatus();
    expect(status.connected).toBe(false);
    expect(status.models).toEqual([]);
  });

  it('returns connected:false on network exception (ECONNREFUSED)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const status = await checkOllamaStatus();
    expect(status.connected).toBe(false);
    expect(status.models).toEqual([]);
  });

  it('returns empty models array when upstream omits the field', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const status = await checkOllamaStatus();
    expect(status.connected).toBe(true);
    expect(status.models).toEqual([]);
  });

  it('hits the /api/tags endpoint', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });

    await checkOllamaStatus();
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/tags');
  });
});
