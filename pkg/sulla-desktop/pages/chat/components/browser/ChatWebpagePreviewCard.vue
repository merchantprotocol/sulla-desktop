<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article v-if="isVisible" class="webpage-preview" aria-label="Webpage preview">
    <header class="webpage-preview__header">
      <span class="webpage-preview__globe" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg>
      </span>
      <span class="webpage-preview__meta">
        <strong>{{ snapshot.title || 'Web page' }}</strong>
        <small>{{ snapshot.safeAddress }}</small>
      </span>
      <span v-if="snapshot.state === 'closed'" class="webpage-preview__closed">Closed</span>
    </header>

    <div class="webpage-preview__body">
      <img v-if="rasterSource" :src="rasterSource" alt="Authorized webpage snapshot" />
      <p v-else-if="snapshot.state === 'closed'" class="webpage-preview__placeholder">Tab closed. The last available view is frozen.</p>
      <p v-else class="webpage-preview__placeholder">Preview not available yet.</p>
    </div>

    <footer class="webpage-preview__actions">
      <button type="button" :disabled="snapshot.state !== 'live'" @click="emit('reload-view')">Reload view</button>
      <button type="button" @click="emit('open-in-tab')">Open in tab</button>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import {
  BrowserPreviewPolicy,
  type BrowserPreviewChatMode,
  type EphemeralBrowserPreviewCardSnapshot,
} from '@pkg/shared/browserPreviewPolicy';

const props = defineProps<{
  snapshot: EphemeralBrowserPreviewCardSnapshot;
  mode: BrowserPreviewChatMode;
}>();

const emit = defineEmits<{
  (event: 'reload-view'): void;
  (event: 'open-in-tab'): void;
}>();

const isVisible = computed(() => BrowserPreviewPolicy.isVisibleInMode(props.snapshot.visibility, props.mode));
const rasterSource = computed(() => BrowserPreviewPolicy.safeRasterSource(props.snapshot.rasterDataUrl));
</script>

<style scoped>
.webpage-preview{display:grid;gap:0;max-width:560px;margin:8px 0;overflow:hidden;border:1px solid var(--border-subtle);border-radius:10px;background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box}
.webpage-preview__header{display:flex;align-items:center;gap:10px;min-width:0;padding:9px 11px}
.webpage-preview__globe{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:8px;background:var(--bg-page);color:var(--primary-color-text-override, var(--accent))}
.webpage-preview__globe svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.webpage-preview__meta{display:block;flex:1;min-width:0}.webpage-preview__meta strong,.webpage-preview__meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.webpage-preview__meta strong{font:600 12.5px var(--font-body)}.webpage-preview__meta small{margin-top:3px;color:var(--text-dim);font:11px var(--font-body)}
.webpage-preview__closed{flex:none;color:var(--text-dim);font:11px var(--font-body)}
.webpage-preview__body{display:grid;place-items:center;min-height:132px;max-height:360px;overflow:hidden;border-top:1px solid var(--border-subtle);background:var(--bg-page)}
.webpage-preview__body img{display:block;width:100%;height:auto;max-height:360px;object-fit:contain}.webpage-preview__placeholder{margin:0;padding:30px 14px;color:var(--text-dim);font:12px/1.45 var(--font-body);text-align:center}
.webpage-preview__actions{display:flex;justify-content:flex-end;gap:6px;padding:8px 10px;border-top:1px solid var(--border-subtle)}.webpage-preview__actions button{padding:5px 9px;border:1px solid var(--border-default);border-radius:6px;background:transparent;color:var(--text-secondary);font:500 11.5px var(--font-body)}.webpage-preview__actions button:last-child{color:var(--primary-color-text-override, var(--accent));border-color:var(--accent)}.webpage-preview__actions button:disabled{opacity:.55;cursor:not-allowed}.webpage-preview__actions button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
