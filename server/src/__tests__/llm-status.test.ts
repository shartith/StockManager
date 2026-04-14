/**
 * ollama.ts — checkLlmStatus coverage (was not tested by the existing
 * callLlm resilience suite)
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
    mlxUrl: 'http://localhost:11434',
    mlxModel: 'qwen3:4b',
    mlxEnabled: true,
    debateMode: false,
    investmentStyle: 'balanced',
  })),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('checkLlmStatus', () => {
  let checkLlmStatus: typeof import('../services/llm').checkLlmStatus;
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
        mlxUrl: 'http://localhost:11434',
        mlxModel: 'qwen3:4b',
        mlxEnabled: true,
      })),
    }));
    vi.doMock('../logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await import('../services/llm');
    checkLlmStatus = mod.checkLlmStatus;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns connected:true with parsed model list', async () => {
    // MLX /v1/models 응답 (OpenAI 호환)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'mlx-community/gemma-3-4b-it-4bit', object: 'model' },
          { id: 'mlx-community/Qwen2.5-7B-Instruct-4bit', object: 'model' },
        ],
      }),
    });

    const status = await checkLlmStatus();
    expect(status.connected).toBe(true);
    expect(status.models).toEqual([
      'mlx-community/gemma-3-4b-it-4bit',
      'mlx-community/Qwen2.5-7B-Instruct-4bit',
    ]);
  });

  it('returns connected:false and empty list on non-OK HTTP response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    const status = await checkLlmStatus();
    expect(status.connected).toBe(false);
    expect(status.models).toEqual([]);
  });

  it('returns connected:false on network exception (ECONNREFUSED)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const status = await checkLlmStatus();
    expect(status.connected).toBe(false);
    expect(status.models).toEqual([]);
  });

  it('returns empty models array when upstream omits the field', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const status = await checkLlmStatus();
    expect(status.connected).toBe(true);
    expect(status.models).toEqual([]);
  });

  it('hits the /v1/models endpoint (OpenAI compat)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await checkLlmStatus();
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/v1/models');
  });
});
