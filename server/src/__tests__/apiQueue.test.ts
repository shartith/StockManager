import { describe, it, expect } from 'vitest';
import { kisApiCall, yahooApiCall, getQueueStatus } from '../services/apiQueue';

describe('API Rate Limit 큐', () => {
  it('큐 상태 초기값 확인', () => {
    const status = getQueueStatus();
    expect(status.kis.pending).toBe(0);
    expect(status.kis.active).toBe(0);
    expect(status.yahoo.pending).toBe(0);
  });

  it('KIS 큐가 함수를 실행하고 결과 반환', async () => {
    const result = await kisApiCall(async () => 'hello', 'test');
    expect(result).toBe('hello');
  });

  it('Yahoo 큐가 함수를 실행하고 결과 반환', async () => {
    const result = await yahooApiCall(async () => 42, 'test');
    expect(result).toBe(42);
  });

  it('에러가 발생하면 reject', async () => {
    await expect(
      kisApiCall(async () => { throw new Error('test error'); }, 'fail')
    ).rejects.toThrow('test error');
  });

  it('순서대로 직렬 실행 (KIS)', async () => {
    const order: number[] = [];
    const promises = [1, 2, 3].map(n =>
      kisApiCall(async () => {
        order.push(n);
        return n;
      }, `seq-${n}`)
    );
    const results = await Promise.all(promises);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]); // 직렬 보장
  });
});
