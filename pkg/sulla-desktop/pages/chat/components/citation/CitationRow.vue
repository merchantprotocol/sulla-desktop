<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <ul class="supporting-reports" aria-label="Sources">
    <li
      v-for="(source, index) in msg.sources"
      :key="index"
      class="report-row"
    >
      <span class="report-number">{{ source.num }}</span>
      <svg
        class="report-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      ><path d="M14 3H6v18h12V7zM14 3v5h4M9 12h6M9 16h6" /></svg>
      <div class="report-copy">
        <b :title="source.title">{{ source.title }}</b>
        <small :title="source.origin">{{ source.origin }}</small>
        <p
          v-if="errors[index]"
          class="report-error"
          role="alert"
        >
          {{ errors[index] }}
        </p>
      </div>
      <a
        v-if="resolver.webUrl(source)"
        :href="resolver.webUrl(source)"
        target="_blank"
        rel="noopener noreferrer"
      >Read source <span aria-hidden="true">↗</span></a>
      <button
        v-else
        type="button"
        :disabled="busy.has(index)"
        @click="open(source, index)"
      >
        {{ busy.has(index) ? 'Opening…' : 'Read report' }} <span aria-hidden="true">↗</span>
      </button>
      <ChatFileDownload
        v-if="!resolver.webUrl(source)"
        :key="source.origin"
        :file-id="() => reportFile(source).then(file => file.fileId)"
        :name="source.origin.split(/[\\/]/).at(-1) || source.title"
      />
    </li>
  </ul>
</template>

<script setup lang="ts">
import ChatFileDownload from '../files/ChatFileDownload.vue';
import { reactive } from 'vue';

import { SupportingReportResolver } from '../../services/SupportingReportResolver';

import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { CitationMessage } from '../../models/Message';

const props = defineProps<{ msg: CitationMessage; }>();
const resolver = new SupportingReportResolver(ipcRenderer);
const busy = reactive(new Set<number>());
const errors = reactive<Record<number, string>>({});

async function reportFile(source: CitationMessage['sources'][number]) {
  const file = await resolver.file(source);
  await resolver.verify(file);
  return file;
}

async function open(source: CitationMessage['sources'][number], index: number): Promise<void> {
  if (busy.has(index)) return;
  busy.add(index); delete errors[index];
  try {
    const file = await reportFile(source);
    if (supportsDocumentEditor(file.path)) await openWorkspaceTab({ mode: 'paper', documentFile: file });
    else await openWorkspaceTab({ mode: 'files', title: source.title, filesNavigation: { ...file, section: 'detail' } });
  } catch (error) { errors[index] = error instanceof Error ? error.message : 'The report could not be opened. Please retry.' } finally { busy.delete(index) }
}
</script>

<style scoped>
.supporting-reports {
  margin: 12px 0 0; padding: 6px 0 0; list-style: none;
  border-top: 1px solid var(--border-default);
  color: var(--text-secondary); font: 13px var(--font-body);
}
.report-row { display: flex; align-items: center; gap: 8px; min-height: 34px; min-width: 0; }
.report-number { flex: none; width: 14px; color: var(--primary-color-text-override, var(--accent)); font: 11.5px var(--font-mono); }
.report-icon { width: 16px; height: 18px; flex: none; color: var(--text-muted); }
.report-copy { min-width: 0; flex: 1; display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 8px; }
.report-copy b, .report-copy small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.report-copy b { color: var(--text-primary); font-size: 13px; font-weight: 500; }
.report-copy small { color: var(--text-muted); font: 11.5px var(--font-mono); }
.report-row > button, .report-row > a { flex: none; padding: 2px 9px; border: 1px solid var(--border-default); border-radius: 8px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; text-decoration: none; }
.report-row > button:hover, .report-row > a:hover { background: var(--bg-surface); color: var(--text-primary); }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.report-error { flex-basis: 100%; color: var(--status-error); margin: 4px 0; line-height: 1.5; }
</style>
