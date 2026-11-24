<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="inline-image-preview">
    <p v-if="error" class="image-error" role="alert">{{ error }}</p>
    <button
      v-else
      ref="trigger"
      class="image-trigger"
      type="button"
      :aria-label="'Enlarge ' + name"
      @click="openLightbox"
    >
      <img :src="previewUrl" :alt="altText || name" />
    </button>

    <dialog
      ref="dialog"
      class="image-lightbox"
      :aria-label="'Full-size preview of ' + name"
      @close="restoreFocus"
      @click.self="closeLightbox"
    >
      <header class="lightbox-header">
        <strong>{{ name }}</strong>
        <span class="lightbox-spacer" />
        <button type="button" @click="openInTab">Open in tab</button>
        <button type="button" aria-label="Close preview" @click="closeLightbox">Close</button>
      </header>
      <img v-if="lightboxOpen && previewUrl && !error" :src="previewUrl" :alt="altText || name" />
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import { InlineImagePreviewSource, type InlineFileActionReference } from './inlineFilePreview';

const props = defineProps<{
  fileId: string;
  name: string;
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  altText?: string;
}>();

const emit = defineEmits<{
  'open-in-tab': [reference: InlineFileActionReference];
}>();

const source = new InlineImagePreviewSource();
const previewUrl = ref('');
const error = ref('');
const dialog = ref<HTMLDialogElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const lightboxTrigger = ref<HTMLElement | null>(null);
const lightboxOpen = ref(false);

function refreshPreview(): void {
  try {
    previewUrl.value = source.replace(props.bytes, props.mimeType);
    error.value = '';
  } catch (reason) {
    previewUrl.value = '';
    error.value = reason instanceof Error ? reason.message : 'This image cannot be previewed.';
  }
}

function openLightbox(): void {
  lightboxTrigger.value = trigger.value;
  const element = dialog.value;
  if (!element) return;
  if (element.open) return;
  lightboxOpen.value = true;
  if (typeof element.showModal === 'function') element.showModal();
  else element.setAttribute('open', '');
}

function closeLightbox(): void {
  const element = dialog.value;
  if (!element) return;
  if (element.open && typeof element.close === 'function') element.close();
  else {
    element.removeAttribute('open');
    restoreFocus();
  }
}

function restoreFocus(): void {
  const opener = lightboxTrigger.value;
  lightboxTrigger.value = null;
  lightboxOpen.value = false;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

function openInTab(): void {
  emit('open-in-tab', { fileId: props.fileId, name: props.name, path: props.path });
  closeLightbox();
}

watch(() => [props.bytes, props.mimeType] as const, refreshPreview, { immediate: true });
onBeforeUnmount(() => source.release());
</script>

<style scoped>
.inline-image-preview { min-width: 0; background: var(--bg-surface-alt); }
.image-trigger { display: block; width: 100%; max-height: 440px; overflow: hidden; padding: 0; border: 0; background: var(--bg-surface-alt); cursor: zoom-in; }
.image-trigger:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.image-trigger img { display: block; width: 100%; height: auto; max-height: 440px; object-fit: contain; }
.image-error { margin: 0; padding: 16px; color: var(--status-error); font-size: 12px; }
.image-lightbox:not([open]) { display: none; }
.image-lightbox { position: fixed; inset: 3vh 3vw; display: flex; flex-direction: column; width: 94vw; max-width: none; height: 94vh; max-height: none; overflow: hidden; padding: 0; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--elev-float); }
.image-lightbox::backdrop { background: var(--bg-overlay, rgb(0 0 0 / 55%)); }
.lightbox-header { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border-subtle); }
.lightbox-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; }
.lightbox-spacer { flex: 1; }
.lightbox-header button { min-height: 28px; padding: 0 9px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; }
.image-lightbox > img { display: block; width: 100%; height: auto; min-height: 0; flex: 1; object-fit: contain; padding: 12px; }
.lightbox-header button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
@media (max-width: 600px) { .image-lightbox { inset: 0; width: 100vw; height: 100vh; border-radius: 0; } }
</style>
