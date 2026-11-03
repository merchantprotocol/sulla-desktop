<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Mic / stop toggle (steel-blue). -->
<template>
  <button
    :class="['mic-btn', { live }]"
    type="button"
    :title="live ? 'Stop recording' : 'Start voice input (⌘/)'"
    @click="$emit('toggle')"
  >
    <span class="classic-mic">{{ live ? '■' : '◉' }}</span>
    <svg class="noir-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
    </svg>
  </button>
</template>

<script setup lang="ts">
defineProps<{ live?: boolean }>();
defineEmits<{ (e: 'toggle'): void }>();
</script>

<style scoped>
.mic-btn {
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  color: var(--accent-hover); font-size: 15px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; align-self: center;
  transition: all 0.2s ease; padding: 0;
}
.mic-btn:hover {
  background: var(--accent-dim);
  border-color: var(--accent-hover); color: var(--accent-hover);
  box-shadow: 0 0 14px var(--accent-glow);
}
.mic-btn.live {
  background: var(--accent); border-color: var(--accent-hover);
  color: var(--text-on-accent); animation: chat-pulse-glow 1.6s ease-in-out infinite;
}
.noir-mic { display: none; width: 17px; height: 17px; }
.mic-btn {
  width: 34px; height: 34px; border: 0; color: var(--text-muted); background: transparent;
  transition: background 0.16s, color 0.16s, box-shadow 0.16s;
}
.classic-mic { display: none; }
.noir-mic { display: block; }
.mic-btn:hover { border: 0; color: var(--text-primary); background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: none; }
.mic-btn.live {
  color: var(--text-primary); background: color-mix(in srgb, var(--accent) 30%, transparent); border: 0;
  animation: noir-mic-pulse 1.6s cubic-bezier(.22, 1, .36, 1) infinite;
}
@keyframes noir-mic-pulse {
  from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent-hover) 45%, transparent); }
  to { box-shadow: 0 0 0 12px color-mix(in srgb, var(--accent-hover) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .mic-btn.live { animation: none; }
}
</style>
