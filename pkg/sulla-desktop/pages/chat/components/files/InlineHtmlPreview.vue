<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div ref="previewRoot" class="inline-html-preview">
    <div :class="['html-stage', 'view-' + view]">
      <webview
        v-if="shouldMountPreview && !renderError"
        :key="'inline-' + previewGeneration"
        :partition="partition"
        :src="previewUrl"
        :aria-label="'Preview of ' + name"
        webpreferences="nodeIntegration=no,contextIsolation=yes,sandbox=yes,webSecurity=yes,disableDialogs=yes,nodeIntegrationInSubFrames=no,nodeIntegrationInWorker=no"
        @render-process-gone="handleRenderProcessGone"
        @unresponsive="handleUnresponsive"
      />
    </div>
    <div v-if="renderError" class="preview-error" role="alert">
      <span>{{ renderError }}</span>
      <button type="button" @click="reloadPreview">Reload</button>
    </div>

    <dialog
      ref="dialog"
      class="html-lightbox"
      :aria-label="'Full-screen preview of ' + name"
      @close="restoreFocus"
      @cancel="handleCancel"
      @click.self="closeFullscreen"
    >
      <header class="lightbox-header">
        <strong>{{ name }}</strong>
        <span class="lightbox-spacer" />
        <button type="button" @click="openInTab">Open in tab</button>
        <button type="button" aria-label="Close preview" @click="closeFullscreen">Close</button>
      </header>
      <webview
        v-if="fullscreenOpen && !renderError"
        :key="'fullscreen-' + previewGeneration"
        :partition="partition"
        :src="previewUrl"
        :aria-label="'Full-screen preview of ' + name"
        webpreferences="nodeIntegration=no,contextIsolation=yes,sandbox=yes,webSecurity=yes,disableDialogs=yes,nodeIntegrationInSubFrames=no,nodeIntegrationInWorker=no"
        @render-process-gone="handleRenderProcessGone"
        @unresponsive="handleUnresponsive"
      />
      <div v-if="fullscreenOpen && renderError" class="preview-error" role="alert">
        <span>{{ renderError }}</span>
        <button type="button" @click="reloadPreview">Reload</button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { INLINE_HTML_PREVIEW_PARTITION } from '@pkg/shared/inlineHtmlPreview';
import { InlineHtmlPreviewDocument, type InlineFileActionReference } from './inlineFilePreview';

const props = defineProps<{
  fileId: string;
  name: string;
  path: string;
  source: string;
  assetBaseUrl?: string;
  view: 'desktop' | 'phone';
}>();

const emit = defineEmits<{
  'open-in-tab': [reference: InlineFileActionReference];
}>();

const previewDocument = new InlineHtmlPreviewDocument();
const previewUrl = computed(() => previewDocument.toDataUrl(props.source, props.assetBaseUrl));
const partition = INLINE_HTML_PREVIEW_PARTITION;
const previewRoot = ref<HTMLElement | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const fullscreenTrigger = ref<HTMLElement | null>(null);
const fullscreenOpen = ref(false);
const hasIntersected = ref(false);
const shouldMountPreview = computed(() => hasIntersected.value);
const previewGeneration = ref(0);
const renderError = ref('');
let intersectionObserver: IntersectionObserver | undefined;

onMounted(() => {
  const root = previewRoot.value;
  if (typeof IntersectionObserver === 'undefined' || !root) {
    // Electron supports IntersectionObserver; mounting immediately is a safe
    // compatibility fallback for test DOMs and older embedders.
    hasIntersected.value = true;
    return;
  }
  intersectionObserver = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    hasIntersected.value = true;
    intersectionObserver?.disconnect();
    intersectionObserver = undefined;
  }, { rootMargin: '100px' });
  intersectionObserver.observe(root);
});

onBeforeUnmount(() => intersectionObserver?.disconnect());

function handleRenderProcessGone(): void {
  renderError.value = 'The HTML preview stopped unexpectedly.';
}

function handleUnresponsive(): void {
  renderError.value = 'The HTML preview is not responding.';
}

function reloadPreview(): void {
  renderError.value = '';
  previewGeneration.value++;
}

function openFullscreen(trigger: HTMLElement): void {
  fullscreenTrigger.value = trigger;
  const element = dialog.value;
  if (!element) return;
  if (element.open) return;
  fullscreenOpen.value = true;
  if (typeof element.showModal === 'function') element.showModal();
  else element.setAttribute('open', '');
}

function closeFullscreen(): void {
  const element = dialog.value;
  if (!element) return;
  if (element.open && typeof element.close === 'function') element.close();
  else {
    element.removeAttribute('open');
    restoreFocus();
  }
}

function handleCancel(event: Event): void {
  // Keep restoration in the close event, after the native dialog has finished
  // closing. Otherwise Escape can focus the trigger while the modal is still
  // active, and the browser will move focus away again.
  event.preventDefault();
  closeFullscreen();
}

function restoreFocus(): void {
  const trigger = fullscreenTrigger.value;
  fullscreenTrigger.value = null;
  fullscreenOpen.value = false;
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openInTab(): void {
  emit('open-in-tab', { fileId: props.fileId, name: props.name, path: props.path });
  closeFullscreen();
}

defineExpose({ openFullscreen });
</script>

<style scoped>
.inline-html-preview { min-width: 0; }
.html-stage { display: flex; justify-content: center; min-height: 0; background: var(--bg-surface-alt); }
.html-stage webview { display: block; width: 100%; height: 400px; border: 0; background: #fff; }
.preview-error { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--border-subtle); color: var(--status-error); font-size: 12px; }
.preview-error button { padding: 4px 9px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary); cursor: pointer; font: inherit; }
.preview-error button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.html-stage.view-phone { padding: 16px 0; }
.html-stage.view-phone webview { width: 375px; max-width: 100%; height: 560px; box-shadow: 0 0 0 1px var(--border-default); }
.html-lightbox:not([open]) { display: none; }
.html-lightbox { position: fixed; inset: 3vh 3vw; width: 94vw; max-width: none; height: 94vh; max-height: none; overflow: hidden; padding: 0; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--elev-float); }
.html-lightbox::backdrop { background: var(--bg-overlay, rgb(0 0 0 / 55%)); }
.lightbox-header { display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border-subtle); }
.lightbox-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; }
.lightbox-spacer { flex: 1; }
.lightbox-header button { min-height: 28px; padding: 0 9px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; }
.lightbox-header button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.html-lightbox webview { display: block; width: 100%; height: calc(100% - 42px); border: 0; background: #fff; }
@media (max-width: 600px) { .html-lightbox { inset: 0; width: 100vw; height: 100vh; border-radius: 0; } }
</style>
