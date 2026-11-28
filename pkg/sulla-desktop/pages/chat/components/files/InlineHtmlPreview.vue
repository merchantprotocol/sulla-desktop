<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="inline-html-preview">
    <div :class="['html-stage', 'view-' + view]">
      <iframe
        :srcdoc="srcdoc"
        :title="'Preview of ' + name"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        referrerpolicy="no-referrer"
        loading="lazy"
      />
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
      <iframe
        v-if="fullscreenOpen"
        :srcdoc="srcdoc"
        :title="'Full-screen preview of ' + name"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        referrerpolicy="no-referrer"
      />
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

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
const srcdoc = computed(() => previewDocument.toSrcdoc(props.source, props.assetBaseUrl));
const dialog = ref<HTMLDialogElement | null>(null);
const fullscreenTrigger = ref<HTMLElement | null>(null);
const fullscreenOpen = ref(false);

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
.html-stage iframe { display: block; width: 100%; height: 400px; border: 0; background: #fff; }
.html-stage.view-phone { padding: 16px 0; }
.html-stage.view-phone iframe { width: 375px; max-width: 100%; height: 560px; box-shadow: 0 0 0 1px var(--border-default); }
.html-lightbox:not([open]) { display: none; }
.html-lightbox { position: fixed; inset: 3vh 3vw; width: 94vw; max-width: none; height: 94vh; max-height: none; overflow: hidden; padding: 0; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--elev-float); }
.html-lightbox::backdrop { background: var(--bg-overlay, rgb(0 0 0 / 55%)); }
.lightbox-header { display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border-subtle); }
.lightbox-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; }
.lightbox-spacer { flex: 1; }
.lightbox-header button { min-height: 28px; padding: 0 9px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; }
.lightbox-header button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.html-lightbox iframe { display: block; width: 100%; height: calc(100% - 42px); border: 0; background: #fff; }
@media (max-width: 600px) { .html-lightbox { inset: 0; width: 100vw; height: 100vh; border-radius: 0; } }
</style>
