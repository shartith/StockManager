/**
 * v4.18.0: LLM provider 자동 스위치 테스트 (UC-06 보강)
 *
 * primary URL 3회 retry 실패 시 fallback URL로 1회 시도.
 * 이 테스트는 기존 llm.test.ts와 독립된 파일에서 vi.resetModules()로
 * 깨끗한 module state를 확보한다 (llmQueue leakage 방지).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function setupMocks(settingsOverrides: Record<string, any> = {}) {
  vi.doMock('../db', () => ({
    queryAll: vi.fn(() => []),
    queryOne: vi.fn(() => null),
    execute: vi.fn(),
  }));
  vi.doMock('../services/settings', () => ({
    getSettings: vi.fn(() => ({
      llmUrl: 'https://primary.example.com/v1',
      llmModel: 'primary-model',
      llmEnabled: true,
      llmApiKey: 'primary-key',
      debateMode: false,
      investmentStyle: 'balanced',
      ...settingsOverrides,
    })),
  }));
  vi.doMock('../logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
}

describe('LLM provider 자동 스위치 (UC-06 v4.18.0)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  it('primary 성공 시 fallback 호출 안 함 (기존 동작)', async () => {
    setupMocks({
      llmFallbackUrl: 'http://localhost:11434/v1',
      llmFallbackModel: 'fallback-model',
    });
    const { callLlm } = await import('../services/llm');

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'primary-ok' } }] }),
    });

    const result = await callLlm('primary-model', 'https://primary.example.com/v1', 'p', 's', 256);
    expect(result).toBe('primary-ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // fallback URL 호출 없음
    const urls = fetchSpy.mock.calls.map(c => String(c[0]));
    expect(urls.every(u => u.startsWith('https://primary.example.com'))).toBe(true);
  });

  it('primary 3회 전부 실패 + fallback 성공 → fallback 결과 반환', async () => {
    setupMocks({
      llmFallbackUrl: 'http://localhost:11434/v1',
      llmFallbackModel: 'fallback-model',
      llmFallbackApiKey: 'fallback-key',
    });
    const { callLlm } = await import('../services/llm');

    // primary 3회 실패 (retriable 에러)
    fetchSpy
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      // fallback 성공
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'fallback-ok' } }] }),
      });

    const result = await callLlm('primary-model', 'https://primary.example.com/v1', 'p', 's', 256);
    expect(result).toBe('fallback-ok');
    expect(fetchSpy).toHaveBeenCalledTimes(4); // primary 3 + fallback 1

    // 마지막 호출이 fallback URL
    const lastUrl = String(fetchSpy.mock.calls[3][0]);
    expect(lastUrl).toContain('localhost:11434');

    // fallback 요청 body에 fallback model 사용되는지
    const lastBody = JSON.parse(fetchSpy.mock.calls[3][1].body as string);
    expect(lastBody.model).toBe('fallback-model');
  });

  it('primary 3회 실패 + fallback 실패 → 최종 throw', async () => {
    setupMocks({
      llmFallbackUrl: 'http://localhost:11434/v1',
      llmFallbackModel: 'fallback-model',
    });
    const { callLlm } = await import('../services/llm');

    fetchSpy.mockRejectedValue(new Error('fetch failed'));

    await expect(
      callLlm('primary-model', 'https://primary.example.com/v1', 'p', 's', 256)
    ).rejects.toThrow();

    // primary 3 + fallback 1 = 4회 호출
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('fallback URL 미설정 → 기존 동작 (primary 3회 후 throw)', async () => {
    setupMocks({}); // fallback 없음
    const { callLlm } = await import('../services/llm');

    fetchSpy.mockRejectedValue(new Error('fetch failed'));

    await expect(
      callLlm('primary-model', 'https://primary.example.com/v1', 'p', 's', 256)
    ).rejects.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(3); // primary만
  });

  it('fallback URL === primary URL 이면 중복 회피 (skip)', async () => {
    setupMocks({
      llmFallbackUrl: 'https://primary.example.com/v1', // 동일
      llmFallbackModel: 'fallback-model',
    });
    const { callLlm } = await import('../services/llm');

    fetchSpy.mockRejectedValue(new Error('fetch failed'));

    await expect(
      callLlm('primary-model', 'https://primary.example.com/v1', 'p', 's', 256)
    ).rejects.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(3); // fallback 시도 안 함
  });

  it('fallback API 키가 다르면 fallback 호출에 fallback 키 사용', async () => {
    setupMocks({
      llmFallbackUrl: 'http://localhost:11434/v1',
      llmFallbackModel: 'fallback-model',
      llmFallbackApiKey: 'SECRET_FALLBACK',
    });
    const { callLlm } = await import('../services/llm');

    fetchSpy
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

    await callLlm('primary-model', 'https://primary.example.com/v1', 'p', 's', 256, 'PRIMARY_KEY');

    // 마지막(fallback) 호출의 Authorization 헤더 확인
    const lastCall = fetchSpy.mock.calls[3];
    const headers = lastCall[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer SECRET_FALLBACK');
  });
});
