import { ref, computed, watch, type Ref } from 'vue';

/**
 * 클라이언트 측 pagination 헬퍼 — source 배열을 slice로 잘라 반환.
 *
 * @param source ref로 감싼 전체 배열
 * @param initialSize 기본 페이지당 건수
 */
export function usePagination<T>(source: Ref<T[]>, initialSize = 50) {
  const page = ref(1);
  const pageSize = ref(initialSize);
  const total = computed(() => source.value.length);

  // source가 줄어들어 현재 page가 범위를 벗어나면 마지막 페이지로 clamp
  watch(total, (n) => {
    const totalPages = Math.max(1, Math.ceil(n / pageSize.value));
    if (page.value > totalPages) page.value = totalPages;
  });

  const paged = computed(() => {
    const start = (page.value - 1) * pageSize.value;
    return source.value.slice(start, start + pageSize.value);
  });

  function reset() { page.value = 1; }

  return { page, pageSize, total, paged, reset };
}
