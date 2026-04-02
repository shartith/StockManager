/**
 * KIS API Rate Limit 큐
 *
 * KIS API는 초당 20건 제한. 여러 스케줄러 작업이 동시에 실행될 때
 * API 호출이 겹치면 429 에러가 발생할 수 있음.
 * 이 큐는 모든 KIS API 호출을 중앙에서 직렬화하여 rate limit을 보장.
 */

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  label?: string;
}

class ApiRateLimitQueue {
  private queue: QueueItem<any>[] = [];
  private processing = false;
  private lastCallTime = 0;
  private minInterval: number; // ms between calls
  private maxConcurrent: number;
  private activeCount = 0;

  constructor(callsPerSecond: number = 15, maxConcurrent: number = 1) {
    // KIS API: 초당 20건 제한 → 15건으로 여유 확보
    this.minInterval = Math.ceil(1000 / callsPerSecond);
    this.maxConcurrent = maxConcurrent;
  }

  /** 큐에 API 호출 등록 — await하면 결과 반환 */
  enqueue<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, label });
      this.processQueue();
    });
  }

  /** 큐 크기 */
  get size(): number {
    return this.queue.length;
  }

  /** 활성 요청 수 */
  get active(): number {
    return this.activeCount;
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    if (this.activeCount >= this.maxConcurrent) return;

    this.processing = true;

    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const now = Date.now();
      const elapsed = now - this.lastCallTime;

      if (elapsed < this.minInterval) {
        await new Promise(r => setTimeout(r, this.minInterval - elapsed));
      }

      const item = this.queue.shift();
      if (!item) break;

      this.activeCount++;
      this.lastCallTime = Date.now();

      // 비동기 실행 — 완료 대기하지 않고 다음 처리 가능 (maxConcurrent > 1일 때)
      item.fn()
        .then(result => {
          item.resolve(result);
        })
        .catch(error => {
          item.reject(error);
        })
        .finally(() => {
          this.activeCount--;
          // 다음 항목 처리
          if (this.queue.length > 0) {
            setTimeout(() => this.processQueue(), 0);
          }
        });
    }

    this.processing = false;
  }
}

// 싱글턴 인스턴스
// KIS API: 초당 15건 (20건 제한에서 여유 확보), 동시 1건 (직렬화)
export const kisApiQueue = new ApiRateLimitQueue(15, 1);

// Yahoo Finance: 초당 5건, 동시 3건 (병렬 허용)
export const yahooApiQueue = new ApiRateLimitQueue(5, 3);

/**
 * KIS API 호출을 큐를 통해 실행
 * 기존 sleep(100~500) 대신 이 함수를 사용
 *
 * @example
 * const data = await kisApiCall(() => fetch(url, options), 'getPrice-AAPL');
 */
export async function kisApiCall<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  return kisApiQueue.enqueue(fn, label);
}

/**
 * Yahoo Finance API 호출을 큐를 통해 실행
 */
export async function yahooApiCall<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  return yahooApiQueue.enqueue(fn, label);
}

/** 큐 상태 조회 (디버깅/모니터링용) */
export function getQueueStatus() {
  return {
    kis: { pending: kisApiQueue.size, active: kisApiQueue.active },
    yahoo: { pending: yahooApiQueue.size, active: yahooApiQueue.active },
  };
}
