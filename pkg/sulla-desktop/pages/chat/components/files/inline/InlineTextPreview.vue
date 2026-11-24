<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <section class="inline-text-preview" :data-kind="kind">
    <template v-if="kind === 'markdown'">
      <div class="inline-preview-tools" aria-label="Markdown preview actions">
        <button
          v-if="!editState.editing && canEditMarkdown"
          type="button"
          class="inline-preview-action"
          aria-label="Edit Markdown"
          @click="beginEdit"
        >Edit</button>
        <template v-if="editState.editing">
          <button
            type="button"
            class="inline-preview-action is-primary"
            :disabled="!editState.canSave"
            @click="requestSave"
          >{{ editState.saveStatus === 'saving' ? 'Saving…' : 'Save' }}</button>
          <button type="button" class="inline-preview-action" @click="discardDraft">{{ editState.externalChange ? 'Discard draft and reload' : 'Discard draft' }}</button>
        </template>
      </div>

      <p v-if="editState.message" class="inline-preview-message" :class="`is-${editState.saveStatus}`" role="status">
        {{ editState.message }}
      </p>
      <textarea
        v-if="editState.editing"
        class="inline-markdown-editor"
        :value="editState.draft"
        :aria-label="`Markdown source of ${fileName || 'file'}`"
        :disabled="editState.saveStatus === 'saving'"
        spellcheck="false"
        @input="updateDraft"
      />
      <div
        v-else
        class="inline-markdown-body"
        :data-expanded="markdownExpanded"
        v-html="renderedMarkdown"
      />
      <p v-if="markdownTruncated" class="inline-preview-cap" role="note">Preview limited to the first 200,000 characters. Open in tab for the complete file.</p>
      <button
        v-if="!editState.editing && markdownCanExpand"
        type="button"
        class="inline-preview-expand"
        :aria-expanded="markdownExpanded"
        @click="markdownExpanded = !markdownExpanded"
      >{{ markdownExpanded ? 'Show less' : 'Show all' }}</button>
    </template>

    <template v-else-if="kind === 'code'">
      <div class="inline-preview-tools">
        <button type="button" class="inline-preview-action" @click="copyCode">{{ copyLabel }}</button>
        <span v-if="copyStatus" class="inline-preview-copy-status" role="status">{{ copyStatus }}</span>
      </div>
      <div
        class="inline-code-body"
        :data-expanded="codeExpanded"
        role="region"
        :aria-label="`Code preview of ${fileName || 'file'}`"
        tabindex="0"
      >
        <div v-for="line in codePreview.lines" :key="line.number" class="inline-code-line">
          <span class="inline-code-line-number" aria-hidden="true">{{ line.number }}</span>
          <code v-html="line.html" />
        </div>
      </div>
      <button
        v-if="codeCanExpand"
        type="button"
        class="inline-preview-expand"
        :aria-expanded="codeExpanded"
        @click="codeExpanded = !codeExpanded"
      >{{ codeExpanded ? 'Show less' : 'Show all' }}</button>
      <p v-if="codePreview.truncated" class="inline-preview-cap" role="note">Showing a bounded code preview. Open in tab for the complete file.</p>
    </template>

    <template v-else>
      <div class="inline-csv-scroll" role="region" :aria-label="`CSV preview of ${fileName || 'file'}`" tabindex="0">
        <table class="inline-csv-table">
          <thead>
            <tr>
              <th scope="col" class="inline-csv-index">#</th>
              <th v-for="(header, index) in csvPreview.headers" :key="index" scope="col">{{ header }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in csvPreview.rows" :key="rowIndex">
              <th scope="row" class="inline-csv-index">{{ rowIndex + 1 }}</th>
              <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!csvPreview.headers.length && !csvPreview.rows.length" class="inline-csv-empty">No CSV rows to preview.</p>
      </div>
      <p class="inline-preview-cap" role="note">{{ csvFootnote }}</p>
      <p v-if="csvPreview.malformed" class="inline-preview-message is-error" role="status">The preview ended inside a quoted CSV field; open the file for the complete contents.</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import { CsvPreviewParser, INLINE_CSV_MAX_COLUMNS } from './CsvPreviewParser';
import { InlineCodeHighlighter } from './InlineCodeHighlighter';
import { MarkdownEditSession } from './MarkdownEditSession';
import type { MarkdownSaveOutcome, MarkdownSourceState } from './MarkdownEditSession';
import { MarkdownPreviewSanitizer } from './MarkdownPreviewSanitizer';

const MAX_MARKDOWN_CHARACTERS = 200_000;

const props = withDefaults(defineProps<{
  kind: 'markdown' | 'code' | 'csv';
  content: string;
  fileName?: string;
  language?: string;
  versionToken?: string;
  authorized?: boolean;
  complete?: boolean;
  saveOutcome?: MarkdownSaveOutcome | null;
}>(), {
  fileName: '',
  language: '',
  versionToken: '',
  authorized: false,
  complete: false,
  saveOutcome: null,
});

const emit = defineEmits<{
  'save-request': [request: { requestId: number; fileName: string; content: string; baseVersionId: string }];
}>();

function sourceState(): MarkdownSourceState {
  return {
    content: props.content,
    versionToken: props.versionToken,
    authorized: props.authorized,
    complete: props.complete,
  };
}

const markdownSession = new MarkdownEditSession(sourceState());
const editState = ref(markdownSession.snapshot());
const displayedContent = ref(props.content);
const markdownSanitizer = new MarkdownPreviewSanitizer();
const codeHighlighter = new InlineCodeHighlighter();
const csvParser = new CsvPreviewParser();
const markdownExpanded = ref(false);
const codeExpanded = ref(false);
const copyStatus = ref('');
let copyStatusTimer: ReturnType<typeof setTimeout> | undefined;

function refreshEditState(): void {
  editState.value = markdownSession.snapshot();
}

watch(() => [props.content, props.versionToken, props.authorized, props.complete], () => {
  displayedContent.value = props.content;
  markdownSession.updateSource(sourceState());
  refreshEditState();
});

watch(() => props.saveOutcome, outcome => {
  if (outcome && markdownSession.resolveSave(outcome) && (outcome.status === 'saved' || outcome.status === 'merged')) {
    displayedContent.value = outcome.content;
  }
  refreshEditState();
});

const markdownText = computed(() => displayedContent.value.slice(0, MAX_MARKDOWN_CHARACTERS));
const markdownTruncated = computed(() => displayedContent.value.length > MAX_MARKDOWN_CHARACTERS || !props.complete);
const canEditMarkdown = computed(() => props.kind === 'markdown'
  && !markdownTruncated.value
  && editState.value.canEdit);
const renderedMarkdown = computed(() => markdownSanitizer.render(markdownText.value));
const markdownCanExpand = computed(() => displayedContent.value.length > 900 || displayedContent.value.split(/\r\n|\r|\n/).length > 12);

const codePreview = computed(() => codeHighlighter.highlight(displayedContent.value, props.language || props.fileName));
const codeCanExpand = computed(() => codePreview.value.truncated || codePreview.value.lines.length > 14);
const copyLabel = computed(() => codePreview.value.truncated ? 'Copy preview' : 'Copy');

const csvPreview = computed(() => csvParser.parse(displayedContent.value, { sourceComplete: props.complete }));
const csvFootnote = computed(() => {
  const shown = csvPreview.value.shownRows;
  const total = csvPreview.value.totalRows;
  const rows = total === undefined
    ? `Showing ${shown} ${shown === 1 ? 'row' : 'rows'} · total unavailable`
    : total > shown
      ? `Showing the first ${shown} of ${total} rows`
      : `Showing ${shown} ${shown === 1 ? 'row' : 'rows'}`;
  const columns = csvPreview.value.hasMoreColumns ? ` · first ${INLINE_CSV_MAX_COLUMNS} columns only` : '';
  const capped = csvPreview.value.truncated ? ' · preview capped' : '';
  return `${rows}${columns}${capped}`;
});

function beginEdit(): void {
  if (canEditMarkdown.value) markdownSession.beginEdit();
  refreshEditState();
}

function updateDraft(event: Event): void {
  markdownSession.setDraft((event.target as HTMLTextAreaElement).value);
  refreshEditState();
}

function requestSave(): void {
  const request = markdownSession.requestSave();
  if (!request) return;
  refreshEditState();
  emit('save-request', { ...request, fileName: props.fileName });
}

function discardDraft(): void {
  markdownSession.discardDraft();
  refreshEditState();
}

async function copyCode(): Promise<void> {
  if (copyStatusTimer) clearTimeout(copyStatusTimer);
  try {
    await navigator.clipboard.writeText(codePreview.value.text);
    copyStatus.value = 'Copied';
  } catch {
    copyStatus.value = 'Copy failed';
  }
  copyStatusTimer = setTimeout(() => { copyStatus.value = ''; }, 1600);
}

onUnmounted(() => {
  if (copyStatusTimer) clearTimeout(copyStatusTimer);
});
</script>

<style scoped>
.inline-text-preview { min-width:0; color:var(--text-primary,var(--text)); font-size:13px; }
.inline-preview-tools { display:flex; align-items:center; gap:6px; min-height:34px; padding:3px 12px; border-bottom:1px solid var(--border-muted,var(--border-subtle)); }
.inline-preview-action { min-height:28px; padding:0 9px; border:1px solid var(--border-muted,var(--border-subtle)); border-radius:7px; background:transparent; color:var(--text-secondary,var(--text-muted)); font:inherit; cursor:pointer; }
.inline-preview-action:hover { background:var(--surface-2,var(--bg-surface-alt)); color:var(--text-primary,var(--text)); }
.inline-preview-action:disabled { opacity:.48; cursor:default; }
.inline-preview-action.is-primary { border-color:var(--accent-primary,var(--accent)); color:var(--accent-primary,var(--accent)); }
.inline-preview-copy-status { color:var(--text-muted); font-size:12px; }
.inline-preview-message { margin:8px 12px; padding:8px 10px; border-radius:6px; background:var(--surface-2,var(--bg-surface-alt)); color:var(--text-secondary,var(--text-muted)); }
.inline-preview-message.is-error,.inline-preview-message.is-conflict { color:var(--status-warning,var(--text-primary)); }
.inline-preview-cap { margin:7px 12px; color:var(--text-muted); font-size:11px; }
.inline-markdown-body { position:relative; padding:14px 18px 16px; font-size:13px; line-height:22px; overflow-wrap:anywhere; }
.inline-markdown-body[data-expanded="false"] { max-height:264px; overflow:hidden; }
.inline-markdown-body[data-expanded="false"]::after { position:absolute; right:0; bottom:0; left:0; height:56px; background:linear-gradient(transparent,var(--surface-1,var(--bg-surface))); content:""; pointer-events:none; }
.inline-markdown-body :deep(h1) { margin:0 0 6px; color:var(--text-primary,var(--text)); font-size:18px; }
.inline-markdown-body :deep(h2),.inline-markdown-body :deep(h3) { margin:14px 0 4px; color:var(--text-primary,var(--text)); font-size:14px; }
.inline-markdown-body :deep(p) { margin:0 0 8px; color:var(--text-secondary,var(--text-muted)); }
.inline-markdown-body :deep(ul),.inline-markdown-body :deep(ol) { margin:4px 0 8px; padding-left:22px; }
.inline-markdown-body :deep(a) { color:var(--accent-primary,var(--accent)); }
.inline-markdown-body :deep(pre) { overflow:auto; padding:10px 12px; border-radius:7px; background:var(--surface-2,var(--bg-surface-alt)); font-family:var(--font-mono); }
.inline-markdown-body :deep(code) { font-family:var(--font-mono); }
.inline-markdown-body :deep(blockquote) { margin:8px 0; padding-left:12px; border-left:2px solid var(--border-muted,var(--border-subtle)); color:var(--text-muted); }
.inline-markdown-editor { display:block; box-sizing:border-box; width:100%; min-height:260px; padding:12px 16px; resize:vertical; border:0; outline-color:var(--accent-primary,var(--accent)); background:var(--surface-1,var(--bg-surface)); color:var(--text-primary,var(--text)); font:12.5px/20px var(--font-mono); }
.inline-preview-expand { display:flex; width:100%; min-height:34px; justify-content:center; align-items:center; border-top:1px solid var(--border-muted,var(--border-subtle)); color:var(--text-secondary,var(--text-muted)); background:transparent; font:inherit; cursor:pointer; }
.inline-preview-expand:hover { background:var(--surface-2,var(--bg-surface-alt)); }
.inline-code-body { position:relative; max-height:260px; overflow:hidden; padding:9px 0; font:12.5px/20px var(--font-mono); tab-size:2; }
.inline-code-body[data-expanded="true"] { max-height:none; overflow:auto; }
.inline-code-body[data-expanded="false"]::after { position:absolute; right:0; bottom:0; left:0; height:56px; background:linear-gradient(transparent,var(--surface-1,var(--bg-surface))); content:""; pointer-events:none; }
.inline-code-line { display:flex; min-width:max-content; min-height:20px; white-space:pre; }
.inline-code-line-number { flex:none; width:38px; margin-right:14px; color:var(--text-muted); text-align:right; user-select:none; font-variant-numeric:tabular-nums; }
.inline-code-line code { padding-right:16px; color:var(--text-primary,var(--text)); }
.inline-code-line :deep(.inline-code-keyword) { color:var(--accent-primary,var(--accent)); }
.inline-code-line :deep(.inline-code-string) { color:var(--status-success,var(--text-secondary)); }
.inline-code-line :deep(.inline-code-comment) { color:var(--text-muted); }
.inline-code-line :deep(.inline-code-number) { color:var(--status-warning,var(--text-primary)); }
.inline-csv-scroll { max-height:236px; overflow:auto; }
.inline-csv-table { width:100%; min-width:max-content; border-collapse:collapse; font-size:12px; }
.inline-csv-table th { position:sticky; top:0; z-index:1; padding:7px 12px; background:var(--surface-2,var(--bg-surface-alt)); color:var(--text-secondary,var(--text-muted)); text-align:left; white-space:nowrap; font:500 11px var(--font-mono); box-shadow:inset 0 -1px 0 var(--border-muted,var(--border-subtle)); }
.inline-csv-table td { padding:6px 12px; border-bottom:1px solid var(--border-muted,var(--border-subtle)); color:var(--text-primary,var(--text)); white-space:nowrap; }
.inline-csv-table .inline-csv-index { width:1%; color:var(--text-muted); text-align:right; font-variant-numeric:tabular-nums; }
.inline-csv-empty { padding:12px; color:var(--text-muted); }
</style>
