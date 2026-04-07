<template>
  <Teleport to="body">
    <div class="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm w-full">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="pointer-events-auto glass-card p-4 flex items-start gap-3 cursor-pointer"
          :class="borderClass(toast.type)"
          @click="dismiss(toast.id)"
          role="alert"
          aria-live="polite"
        >
          <span class="text-lg shrink-0 mt-0.5" aria-hidden="true">{{ iconFor(toast.type) }}</span>
          <div class="flex-1 min-w-0">
            <p v-if="toast.title" class="text-sm font-semibold text-txt-primary">{{ toast.title }}</p>
            <p class="text-xs text-txt-secondary mt-0.5 line-clamp-2">{{ toast.message }}</p>
          </div>
          <button
            class="text-txt-tertiary hover:text-txt-primary text-sm shrink-0"
            aria-label="닫기"
            @click.stop="dismiss(toast.id)"
          >&times;</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue';

interface Toast {
  id: number;
  type: 'info' | 'success' | 'warning' | 'error' | 'trade';
  title?: string;
  message: string;
  duration?: number;
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

function iconFor(type: Toast['type']): string {
  const icons: Record<string, string> = {
    info: '💡', success: '✅', warning: '⚠️', error: '❌', trade: '📈',
  };
  return icons[type] || '🔔';
}

function borderClass(type: Toast['type']): string {
  const classes: Record<string, string> = {
    info: 'border-l-4 !border-l-accent',
    success: 'border-l-4 !border-l-green-500',
    warning: 'border-l-4 !border-l-amber-500',
    error: 'border-l-4 !border-l-red-500',
    trade: 'border-l-4 !border-l-profit',
  };
  return classes[type] || '';
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer) { clearTimeout(timer); timers.delete(id); }
  toasts.value = toasts.value.filter(t => t.id !== id);
}

function show(opts: Omit<Toast, 'id'>) {
  const id = nextId++;
  const toast: Toast = { id, ...opts };
  toasts.value = [...toasts.value, toast];

  const duration = opts.duration ?? 5000;
  if (duration > 0) {
    timers.set(id, setTimeout(() => dismiss(id), duration));
  }

  if (toasts.value.length > 5) {
    toasts.value = toasts.value.slice(-5);
  }
}

onUnmounted(() => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});

defineExpose({ show, dismiss });
</script>
