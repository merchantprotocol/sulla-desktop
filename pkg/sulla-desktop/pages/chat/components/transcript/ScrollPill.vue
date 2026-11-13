<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Floating "jump to newest" pill that appears when scrolled up. -->
<template>
  <button v-if="visible" class="scroll-pill" type="button" @click="$emit('jump')">
    New messages
  </button>
</template>

<script setup lang="ts">
defineProps<{ visible: boolean }>();
defineEmits<{ (e: 'jump'): void }>();
</script>

<style scoped>
.scroll-pill {
  /* Sit just above the composer, like mobile. --composer-h is the live
     composer height published by useResizeSync on .main. */
  position: absolute; bottom: calc(var(--composer-h, 140px) + 24px); left: 50%;
  transform: translateX(-50%);
  padding: 8px 14px; border-radius: 100px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--text-secondary);
  background: var(--accent);
  border: 1px solid var(--accent-hover);
  cursor: pointer; backdrop-filter: blur(10px);
  z-index: 16;
  box-shadow: 0 10px 30px var(--bg-overlay), 0 0 20px var(--accent-dim);
  display: inline-flex; align-items: center; gap: 8px;
  transition: all 0.2s ease;
}
.scroll-pill:hover { background: var(--accent); color: var(--text-on-accent); }
.scroll-pill::before { content: "↓"; font-size: 13px; }
</style>
