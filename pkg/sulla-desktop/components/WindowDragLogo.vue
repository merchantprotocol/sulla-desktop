<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div
    class="window-drag-logo"
    :class="{ 'window-drag-logo-dark': forceDark }"
    :style="{ '--logo-size': size + 'px' }"
    aria-label="Sulla Desktop"
    role="img"
  >
    <!-- The Sulla robot mark, drawn from the same vector as sulladesktop.com's
         favicon.svg. A vector stays sharp at title-bar size; the old
         500x82 PNG scaled down to ~20px rendered the thin robot as a faint blur. -->
    <svg
      class="window-drag-logo-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 1.4v2.2" />
      <path d="M0.9 7.4v4.6" />
      <path d="M23.1 7.4v4.6" />
      <path d="M6.2 3.6h11.6a2.6 2.6 0 0 1 2.6 2.6v9.7a2.6 2.6 0 0 1-2.6 2.6h-3.4L12 22.4l-2.4-3.9H6.2a2.6 2.6 0 0 1-2.6-2.6V6.2a2.6 2.6 0 0 1 2.6-2.6z" />
      <path d="M3.6 14.4h16.8" />
      <circle
        cx="8.4"
        cy="9.6"
        r="1.4"
        fill="currentColor"
        stroke="none"
      />
      <circle
        cx="15.6"
        cy="9.6"
        r="1.4"
        fill="currentColor"
        stroke="none"
      />
    </svg>
    <span class="window-drag-logo-word">Sulla Desktop</span>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number; forceDark?: boolean }>(), { size: 20, forceDark: false });
</script>

<style scoped>
.window-drag-logo {
  -webkit-app-region: drag;
  app-region: drag;
  display: flex;
  align-items: center;
  gap: calc(var(--logo-size) * 0.22);
  padding: 4px;
  flex-shrink: 0;
  height: calc(var(--logo-size) + 8px);
  user-select: none;
  -webkit-user-select: none;
}

.window-drag-logo > * {
  pointer-events: none;
}

.window-drag-logo-mark {
  width: var(--logo-size);
  height: var(--logo-size);
  flex-shrink: 0;
  /* Sulla brand cyan, same as the website mark. */
  color: #74d0fb;
}

.window-drag-logo-word {
  font-family: "Inter", var(--font-sans, ui-sans-serif), system-ui, -apple-system, sans-serif;
  font-size: calc(var(--logo-size) * 0.8);
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.015em;
  white-space: nowrap;
  color: var(--text-primary, #0e0c22);
}

.window-drag-logo-dark .window-drag-logo-word {
  color: #fafafa;
}
</style>
