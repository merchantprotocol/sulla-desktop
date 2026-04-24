<!-- Sulla reaching out unprompted (build done, brief ready, etc.) -->
<template>
  <div class="proactive">
    <div class="head">Sulla · proactive</div>
    <div class="body"><strong>{{ msg.headline }}</strong> {{ msg.body }}</div>
  </div>
</template>

<script setup lang="ts">
import type { ProactiveMessage } from '../../models/Message';
defineProps<{ msg: ProactiveMessage }>();
</script>

<style scoped>
.proactive {
  padding: 14px 18px; border-radius: 12px;
  background:
    radial-gradient(ellipse at top right, rgba(80, 150, 179, 0.12), transparent 70%),
    rgba(20, 30, 42, 0.4);
  border: 1px solid rgba(80, 150, 179, 0.22);
  border-right-width: 3px; border-right-color: var(--steel-400);
}
.head {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--steel-400);
  margin-bottom: 8px;
  display: flex; align-items: center; gap: 10px;
}
.head::before {
  content: "◇"; color: var(--steel-400); font-size: 14px;
  filter: drop-shadow(0 0 6px var(--steel-400));
}
.body {
  font-family: var(--serif); font-size: 16px; line-height: 1.55;
  color: var(--read-1);
}
.body strong { color: white; font-style: italic; font-weight: 600; margin-right: 4px; }
</style>
