<template>
  <div class="empty-state">
    <div class="kicker">
      {{ kicker }}
    </div>
    <h2 class="title">
      {{ title }}
    </h2>
    <p
      v-if="message"
      class="message"
    >
      {{ message }}
    </p>
    <div
      v-if="hasActions"
      class="actions"
    >
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from 'vue';

defineProps<{
  kicker:   string;
  title:    string;
  message?: string;
}>();

const slots = useSlots();
const hasActions = computed(() => !!slots.default);
</script>

<style scoped lang="scss">
.empty-state {
  position: relative;
  padding: 80px 40px;
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: rgba(11, 20, 40, 0.3);
  backdrop-filter: blur(4px);
  max-width: 680px;
  margin: 40px auto;
}
.kicker {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.3em;
  color: var(--steel-400);
  text-transform: uppercase;
  margin-bottom: 14px;
}
.title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 40px;
  color: white;
  margin: 0 0 16px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.message {
  font-family: var(--serif);
  font-size: 16px;
  font-style: italic;
  color: var(--steel-200);
  line-height: 1.55;
  max-width: 480px;
  margin: 0 auto 28px;
}
.actions {
  display: inline-flex;
  gap: 10px;
  justify-content: center;
}
</style>
