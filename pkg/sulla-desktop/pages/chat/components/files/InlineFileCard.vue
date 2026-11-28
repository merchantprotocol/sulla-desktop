<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article
    class="inline-file-card"
    :aria-label="'File preview: ' + file.name"
    :tabindex="pdfPreview ? 0 : undefined"
    :role="pdfPreview ? 'group' : undefined"
    @keydown="handlePdfKeyboard"
  >
    <header class="file-header">
      <FileGlyph :name="file.name" :mime="file.mimeType" />
      <span class="file-name" :title="file.name">{{ file.name }}</span>
      <span class="file-path" :title="file.path">{{ file.path }}</span>
      <span v-if="file.sizeLabel" class="file-size">{{ file.sizeLabel }}</span>
      <span class="header-spacer" />

      <div v-if="isReady" class="file-actions">
        <template v-if="htmlPreview">
          <button
            class="file-action"
            type="button"
            :aria-label="'Desktop width for ' + file.name"
            title="Desktop width"
            :aria-pressed="htmlView === 'desktop'"
            @click="htmlView = 'desktop'"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 13.5h4" /></svg><span>Desktop</span>
          </button>
          <button
            class="file-action"
            type="button"
            :aria-label="'Phone width for ' + file.name"
            title="Phone width"
            :aria-pressed="htmlView === 'phone'"
            @click="htmlView = 'phone'"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="2" width="7" height="12" rx="1.5" /><path d="M7.3 12h1.4" /></svg><span>Phone</span>
          </button>
          <button
            class="file-action"
            type="button"
            :aria-label="'Full screen preview of ' + file.name"
            title="Full screen"
            @click="openHtmlFullscreen"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" /></svg><span>Full screen</span>
          </button>
        </template>

        <template v-if="pdfPreview">
          <button
            class="file-action pdf-page-action"
            type="button"
            aria-label="Previous page"
            title="Previous page"
            ref="previousPdfPageButton"
            :disabled="pdfNavigationBlocked || pdfState.pageNumber <= 1"
            @click="previousPdfPage"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
          </button>
          <span class="pdf-page-count" aria-live="polite" aria-atomic="true">{{ pdfPageLabel }}</span>
          <button
            class="file-action pdf-page-action"
            type="button"
            aria-label="Next page"
            title="Next page"
            ref="nextPdfPageButton"
            :disabled="pdfNavigationBlocked || pdfState.pageNumber >= pdfState.pageCount"
            @click="nextPdfPage"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
          </button>
        </template>

        <template v-if="isCompact">
          <button
            class="file-action"
            type="button"
            :aria-label="'Show ' + file.name + ' in Files'"
            title="Show in Files"
            @click="showInFiles"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" /></svg><span>Show in Files</span>
          </button>
          <button
            class="file-action"
            type="button"
            :aria-label="'Download ' + file.name"
            title="Download"
            @click="download"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" /></svg><span>Download</span>
          </button>
        </template>
        <button
          v-if="canOpenInTab"
          class="file-action"
          type="button"
          :aria-label="'Open ' + file.name + ' in a tab'"
          title="Open in tab"
          @click="openInTab"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 8 8M6.5 3.5h-4v10h10v-4" /></svg><span>Open in tab</span>
        </button>
      </div>
    </header>

    <div v-if="hasPreviewCap && isReady" class="file-cap" role="status">
      <span>{{ capLabel }}</span>
      <button v-if="canOpenForCap" type="button" @click="openInTab">
        Open in tab for the full file
      </button>
    </div>

    <p v-if="file.status === 'loading'" class="file-status" role="status">Loading preview…</p>
    <p v-else-if="file.status === 'access-denied' || file.status === 'error'" class="file-status file-error" role="alert">
      {{ file.message || (file.status === 'access-denied' ? 'This file is not available to this chat.' : 'The preview could not be loaded.') }}
    </p>
    <div v-else-if="isReady && htmlPreview" class="file-body">
      <InlineHtmlPreview
        ref="htmlPreviewComponent"
        :file-id="file.fileId"
        :name="file.name"
        :path="file.path"
        :source="htmlPreview.source"
        :asset-base-url="htmlPreview.assetBaseUrl"
        :view="htmlView"
        @open-in-tab="emitOpenInTab"
      />
    </div>
    <div v-else-if="isReady && imagePreview" class="file-body">
      <InlineImagePreview
        :file-id="file.fileId"
        :name="file.name"
        :path="file.path"
        :bytes="imagePreview.bytes"
        :mime-type="imagePreview.mimeType"
        :alt-text="imagePreview.altText"
        @open-in-tab="emitOpenInTab"
      />
    </div>
    <div v-else-if="isReady && archivePreview" class="file-body">
      <InlineArchivePreview
        :name="file.name"
        :entries="archivePreview.entries"
        :total-entries="archivePreview.totalEntries"
      />
    </div>
    <div v-else-if="isReady && pdfPreview" class="file-body">
      <InlinePdfPreview
        v-if="pdfDocumentLoader"
        ref="pdfPreviewComponent"
        :bytes="pdfPreview.bytes"
        :document-loader="pdfDocumentLoader"
        @state-change="onPdfStateChange"
      />
      <p v-else class="file-status file-error" role="alert">This PDF preview is unavailable. Open it in a tab to view it.</p>
    </div>
    <div v-else-if="isReady && file.preview?.kind === 'custom'" class="file-body">
      <slot name="preview" :file="file" />
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import FileGlyph from './FileGlyph.vue';
import InlineArchivePreview from './InlineArchivePreview.vue';
import InlineHtmlPreview from './InlineHtmlPreview.vue';
import InlineImagePreview from './InlineImagePreview.vue';
import InlinePdfPreview from './InlinePdfPreview.vue';
import type { InlinePdfDocumentLoader, InlinePdfPreviewState } from './inlinePdfPreview';
import {
  MAX_INLINE_HTML_SOURCE_CHARACTERS,
  type InlineFileActionReference,
  type InlineFileCardViewModel,
} from './inlineFilePreview';

const props = defineProps<{ file: InlineFileCardViewModel; pdfDocumentLoader?: InlinePdfDocumentLoader }>();

const emit = defineEmits<{
  'open-in-tab': [reference: InlineFileActionReference];
  'show-in-files': [reference: InlineFileActionReference];
  download: [reference: InlineFileActionReference];
}>();

const htmlView = ref<'desktop' | 'phone'>('desktop');
const htmlPreviewComponent = ref<InstanceType<typeof InlineHtmlPreview> | null>(null);
const pdfPreviewComponent = ref<InstanceType<typeof InlinePdfPreview> | null>(null);
const previousPdfPageButton = ref<HTMLButtonElement | null>(null);
const nextPdfPageButton = ref<HTMLButtonElement | null>(null);
const pdfState = ref<InlinePdfPreviewState>({ status: 'loading', pageNumber: 1, pageCount: 0 });

const isReady = computed(() => !props.file.status || props.file.status === 'ready');
const htmlPreview = computed(() => props.file.preview?.kind === 'html' ? props.file.preview : null);
const imagePreview = computed(() => props.file.preview?.kind === 'image' ? props.file.preview : null);
const archivePreview = computed(() => props.file.preview?.kind === 'archive' ? props.file.preview : null);
const pdfPreview = computed(() => props.file.preview?.kind === 'pdf' ? props.file.preview : null);
const pdfNavigationBlocked = computed(() => pdfState.value.status === 'loading' || pdfState.value.status === 'load-error');
const isCompact = computed(() => !props.file.preview || archivePreview.value !== null
  || (props.file.preview.kind === 'custom' && !canOpenInTab.value));
const canOpenInTab = computed(() => props.file.canOpenInTab
  ?? (htmlPreview.value !== null || imagePreview.value !== null || pdfPreview.value !== null || props.file.preview?.kind === 'custom'));
const htmlSourceCapped = computed(() => (htmlPreview.value?.source.length ?? 0) > MAX_INLINE_HTML_SOURCE_CHARACTERS);
const hasPreviewCap = computed(() => Boolean(props.file.cap) || htmlSourceCapped.value);
const canOpenForCap = computed(() => props.file.cap?.canOpenInTab ?? canOpenInTab.value);
const capLabel = computed(() => props.file.cap?.label
  ?? 'HTML preview limited to the first ' + MAX_INLINE_HTML_SOURCE_CHARACTERS.toLocaleString() + ' characters.');
const pdfPageLabel = computed(() => pdfState.value.pageCount > 0 ? `${pdfState.value.pageNumber} / ${pdfState.value.pageCount}` : '— / —');

watch(() => props.file.fileId, () => {
  htmlView.value = 'desktop';
  pdfState.value = { status: 'loading', pageNumber: 1, pageCount: 0 };
});

function onPdfStateChange(state: InlinePdfPreviewState): void {
  pdfState.value = state;
}

async function previousPdfPage(): Promise<void> {
  await pdfPreviewComponent.value?.previousPage();
  await nextTick();
  if (previousPdfPageButton.value?.disabled) nextPdfPageButton.value?.focus();
}

async function nextPdfPage(): Promise<void> {
  await pdfPreviewComponent.value?.nextPage();
  await nextTick();
  if (nextPdfPageButton.value?.disabled) previousPdfPageButton.value?.focus();
}

function handlePdfKeyboard(event: KeyboardEvent): void {
  if (!pdfPreview.value || event.altKey || event.metaKey || event.ctrlKey) return;
  if (event.key === 'ArrowLeft' && pdfState.value.pageNumber <= 1) {
    nextPdfPageButton.value?.focus();
    event.preventDefault();
    return;
  }
  if (event.key === 'ArrowRight' && pdfState.value.pageCount > 0 && pdfState.value.pageNumber >= pdfState.value.pageCount) {
    previousPdfPageButton.value?.focus();
    event.preventDefault();
    return;
  }
  if (!pdfPreviewComponent.value?.handleKey(event.key)) return;
  event.preventDefault();
}

function actionReference(): InlineFileActionReference {
  return { fileId: props.file.fileId, name: props.file.name, path: props.file.path };
}

function openInTab(): void {
  emit('open-in-tab', actionReference());
}

function emitOpenInTab(reference: InlineFileActionReference): void {
  emit('open-in-tab', reference);
}

function showInFiles(): void {
  emit('show-in-files', actionReference());
}

function download(): void {
  emit('download', actionReference());
}

function openHtmlFullscreen(event: MouseEvent): void {
  htmlPreviewComponent.value?.openFullscreen(event.currentTarget as HTMLElement);
}
</script>

<style scoped>
.inline-file-card { container-type: inline-size; min-width: 0; overflow: hidden; margin: 10px 0 0; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-surface); color: var(--text-primary); scroll-margin-top: 12px; }
.inline-file-card:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.file-header { display: flex; align-items: center; gap: 8px; min-width: 0; height: 40px; padding: 0 6px 0 12px; color: var(--text-secondary); }
.file-header :deep(.file-glyph) { width: 17px; height: 17px; border-radius: 4px; color: var(--primary-color-text-override, var(--accent-primary)); background: color-mix(in srgb, var(--accent-primary) 12%, transparent); }
.file-header :deep(.file-glyph svg) { width: 13px; height: 13px; }
.file-name { min-width: 36px; flex: 0 1 auto; overflow: hidden; color: var(--text-primary); font-size: 13px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.file-path { min-width: 0; flex: 0 20 auto; overflow: hidden; color: var(--text-muted); font: 11.5px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.file-size { flex: none; color: var(--text-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.file-size::before { margin-right: 8px; content: '·'; }
.header-spacer { flex: 1; }
.file-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.file-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 28px; height: 28px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
.file-action:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.file-action:disabled { color: var(--text-muted); cursor: default; opacity: .5; }
.file-action:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
.file-action[aria-pressed='true'] { background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface)); color: var(--primary-color-text-override, var(--accent-primary)); }
.file-action svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.pdf-page-count { min-width: 3.25em; color: var(--text-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
.file-body { min-width: 0; border-top: 1px solid var(--border-subtle); }
.file-cap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 7px 12px; border-top: 1px solid var(--border-subtle); color: var(--text-muted); font-size: 11.5px; }
.file-cap button { padding: 0; border: 0; background: transparent; color: var(--primary-color-text-override, var(--accent-primary)); cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 2px; }
.file-cap button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.file-status { margin: 0; padding: 12px; color: var(--text-muted); font-size: 12px; }
.file-status.file-error { border-top: 1px solid var(--border-subtle); color: var(--status-error); }
@container (max-width: 600px) {
  .file-path, .file-size, .file-action span { display: none; }
  .file-action { width: 28px; padding: 0; }
}
</style>
