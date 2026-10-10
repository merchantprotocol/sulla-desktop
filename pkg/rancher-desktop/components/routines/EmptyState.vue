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

.theme-noir .empty-state {
  padding: 68px 40px;
  border: 1px solid var(--nx-hair);
  border-radius: 22px;
  background:
    radial-gradient(70% 100% at 50% 115%, color-mix(in srgb, var(--nx-accent) 12%, transparent), transparent 70%),
    color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.025);
  backdrop-filter: blur(18px);
}

.theme-noir .kicker {
  color: var(--nx-accent-2);
  letter-spacing: 0.14em;
}

.theme-noir .title {
  font-family: 'Playfair Display', Georgia, serif;
  font-style: normal;
  color: var(--nx-read-1);
}

.theme-noir .message {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  font-style: normal;
  color: var(--nx-read-3);
}
</style>
