<script setup lang="ts">
defineProps<{
  title?:    string;
  subtitle?: string;
  /** `top` aligns the control to the top (choice lists); `col` stacks a full-width control under the label. */
  layout?:   'top' | 'col';
  off?:      boolean;
  /** Pixel width of the control column, for choice lists. */
  width?:    number;
}>();
</script>

<template>
  <div
    class="set"
    :class="[layout, { off }]"
  >
    <div
      v-if="title || $slots.label"
      class="l"
    >
      <slot name="label">
        <b>{{ title }}</b>
      </slot>
      <small v-if="subtitle || $slots.subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </small>
    </div>
    <div
      class="c"
      :style="width ? { width: `${ width }px` } : undefined"
    >
      <slot />
    </div>
  </div>
</template>
