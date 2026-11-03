<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
  background: var(--bg-surface);
  backdrop-filter: blur(4px);
  max-width: 680px;
  margin: 40px auto;
}
.kicker {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.3em;
  color: var(--steel-400);
  text-transform: uppercase;
  margin-bottom: 14px;
}
.title {
  font-family: var(--font-display);
  font-style: italic;
  font-size: 40px;
  color: var(--text-primary);
  margin: 0 0 16px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.message {
  font-family: var(--font-display);
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

.empty-state {
  padding: 68px 40px;
  border: 1px solid var(--border-subtle);
  border-radius: 22px;
  background:
    radial-gradient(70% 100% at 50% 115%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%),
    color-mix(in srgb, var(--text-primary) 3.5%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--border-subtle) 2.5%, transparent);
  backdrop-filter: blur(18px);
}

.kicker {
  color: var(--accent-hover);
  letter-spacing: 0.14em;
}

.title {
  font-family: var(--font-display), Georgia, serif;
  font-style: normal;
  color: var(--text-primary);
}

.message {
  font-family: var(--font-body);
  font-size: 14px;
  font-style: normal;
  color: var(--text-muted);
}
</style>
