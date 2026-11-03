<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Full-screen backdrop shown while files are being dragged over the window.
-->
<template>
  <Transition name="drop-fade">
    <div v-if="active" class="drop-overlay" aria-hidden="true">
      <div class="drop-card">
        <div class="drop-icon">◇</div>
        <div class="drop-title">drop to attach</div>
        <div class="drop-sub">Sulla will read the files along with your message</div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{ active: boolean }>();
</script>

<style scoped>
.drop-overlay {
  position: absolute; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-elevated);
  backdrop-filter: blur(10px);
  pointer-events: none;
}
.drop-card {
  text-align: center; padding: 48px 72px;
  border: 2px dashed var(--accent-hover); border-radius: 16px;
  background: var(--accent-glow);
  box-shadow: 0 0 60px var(--accent-glow);
}
.drop-icon {
  font-size: 44px; color: var(--accent-hover); margin-bottom: 14px;
  filter: drop-shadow(0 0 14px var(--accent-glow));
}
.drop-title {
  font-family: var(--font-display); font-style: italic; font-size: 22px;
  color: var(--text-on-accent); margin-bottom: 8px;
}
.drop-sub {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--accent-hover);
}
.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s ease; }
.drop-fade-enter-from,  .drop-fade-leave-to    { opacity: 0; }
</style>
