<template>
  <div
    class="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm
           border-profit/20 bg-profit/5 text-profit"
    role="alert"
  >
    <div class="flex items-center gap-2 min-w-0">
      <svg class="h-5 w-5 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
      </svg>
      <span class="truncate">{{ message }}</span>
    </div>
    <button
      type="button"
      class="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition
             bg-profit/10 text-profit hover:bg-profit/20"
      @click="$emit('retry')"
    >
      다시 시도
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  message: string;
}>();

defineEmits<{
  retry: [];
}>();
</script>
