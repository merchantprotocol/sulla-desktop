<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
    radial-gradient(ellipse at top right, var(--accent-dim), transparent 70%),
    var(--accent-glow);
  border: 1px solid var(--accent-dim);
  border-right-width: 3px; border-right-color: var(--accent-hover);
}
.head {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--accent-hover);
  margin-bottom: 8px;
  display: flex; align-items: center; gap: 10px;
}
.head::before {
  content: "◇"; color: var(--accent-hover); font-size: 14px;
  filter: drop-shadow(0 0 6px var(--accent-hover));
}
.body {
  font-family: var(--font-display); font-size: 16px; line-height: 1.55;
  color: var(--text-primary);
  white-space: pre-wrap;
}
.body strong { color: var(--text-on-accent); font-style: italic; font-weight: 600; margin-right: 4px; }
</style>
