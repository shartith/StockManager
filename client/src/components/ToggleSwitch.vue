<template>
  <label class="flex items-center gap-2 cursor-pointer select-none">
    <input
      type="checkbox"
      :checked="modelValue"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      class="sr-only"
    />
    <div class="relative">
      <div
        class="w-9 h-5 rounded-full transition-colors"
        :class="modelValue ? 'bg-accent' : 'bg-surface-3'"
      ></div>
      <div
        class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
        :class="modelValue ? 'translate-x-4' : ''"
      ></div>
    </div>
    <span v-if="label" class="text-sm text-txt-secondary">{{ label }}</span>
    <slot />
  </label>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  label?: string;
}>();

defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();
</script>
