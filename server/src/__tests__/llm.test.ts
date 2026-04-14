/**
 * v4.5.2: Ollama call resilience
 *
 * Verifies the four fixes for the OLLAMA_DOWN burst pattern:
 *   1. AbortController-based timeout — slow responses fail cleanly
 *   2. Module-level mutex — concurrent calls serialize, no overlapping fetches
 *   3. Retry with exponential backoff — transient "fetch failed" recovers
 *   4. keep_alive in request body — model stays warm
 *
 * NOTE: vi.resetModules() is required to clear the module-level ollamaQueue
 * promise chain between tests; otherwise a queued failure from one test
 * leaks into the next.
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
    mlxModel: 'exaone3.5:2.4b',
    mlxEnabled: true,
    debateMode: false,
    investmentStyle: 'balanced',
  })),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('callLlm (v4.5.2 resilience)', () => {
  let callLlm: typeof import('../services/llm').callLlm;
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
        mlxModel: 'exaone3.5:2.4b',
        mlxEnabled: true,
        debateMode: false,
        investmentStyle: 'balanced',
      })),
    }));
    vi.doMock('../logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await import('../services/llm');
    callLlm = mod.callLlm;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Happy path ─────────────────────────────────────────────

  it('returns response text on success', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"signal":"BUY"}' } }] }),
    });

    const result = await callLlm('exaone3.5:2.4b', 'http://localhost:11434', 'p', 's', 256);
    expect(result).toBe('{"signal":"BUY"}');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends OpenAI-compatible request body (v4.12.0 MLX)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    await callLlm('mlx-community/gemma-3n-E4B-it-4bit', 'http://localhost:8000', 'my-prompt', 'sys-prompt', 256);

    const callArg = fetchSpy.mock.calls[0][1];
    const url = String(fetchSpy.mock.calls[0][0]);
    const body = JSON.parse(callArg.body as string);

    expect(url).toContain('/v1/chat/completions');
    expect(body.model).toBe('mlx-community/gemma-3n-E4B-it-4bit');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: 'my-prompt' },
    ]);
  });

  it('passes AbortSignal to fetch (Fix #1: timeout)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    await callLlm('m', 'http://localhost:11434', 'p', 's', 256);

    const callArg = fetchSpy.mock.calls[0][1];
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });

  // ── Retry behaviour (Fix #3) ───────────────────────────────

  it('retries on transient "fetch failed" then succeeds', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
      });

    const result = await callLlm('m', 'http://localhost:11434', 'p', 's', 256);
    expect(result).toBe('recovered');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries on ECONNRESET', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

    const result = await callLlm('m', 'http://localhost:11434', 'p', 's', 256);
    expect(result).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retry attempts', async () => {
    fetchSpy.mockRejectedValue(new Error('fetch failed'));

    await expect(
      callLlm('m', 'http://localhost:11434', 'p', 's', 256),
    ).rejects.toThrow('fetch failed');

    // 3 attempts total (1 initial + 2 retries)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on non-retriable HTTP errors (e.g., 400)', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid model',
    });

    await expect(
      callLlm('m', 'http://localhost:11434', 'p', 's', 256),
    ).rejects.toThrow(/HTTP 400/);

    // No retry — HTTP errors aren't retriable in our policy
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ── Mutex / serialization (Fix #2) ─────────────────────────

  it('serializes concurrent calls (only one fetch in flight at a time)', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;

    fetchSpy.mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Yield to event loop so other concurrent tasks have a chance to start
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    // Fire 5 concurrent calls
    await Promise.all([
      callLlm('m', 'http://localhost:11434', 'p1', 's', 256),
      callLlm('m', 'http://localhost:11434', 'p2', 's', 256),
      callLlm('m', 'http://localhost:11434', 'p3', 's', 256),
      callLlm('m', 'http://localhost:11434', 'p4', 's', 256),
      callLlm('m', 'http://localhost:11434', 'p5', 's', 256),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    // Mutex must keep concurrent fetches at exactly 1
    expect(maxConcurrent).toBe(1);
  });

  it('continues processing queue after one call fails', async () => {
    fetchSpy
      // First call: 3 retries all fail
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      // Second call: success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'second-ok' } }] }),
      });

    const [first, second] = await Promise.allSettled([
      callLlm('m', 'http://localhost:11434', 'p1', 's', 256),
      callLlm('m', 'http://localhost:11434', 'p2', 's', 256),
    ]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    if (second.status === 'fulfilled') {
      expect(second.value).toBe('second-ok');
    }
  });
});
