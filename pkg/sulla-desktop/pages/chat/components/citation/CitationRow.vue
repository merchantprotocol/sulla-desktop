<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <details class="supporting-reports">
    <summary>{{ heading }} <span>{{ msg.sources.length }}</span></summary>
    <ul>
      <li
        v-for="source in msg.sources"
        :key="source.num"
        class="report-row"
      >
        <svg
          class="report-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        ><path d="M14 3H6v18h12V7zM14 3v5h4M9 12h6M9 16h6" /></svg>
        <div class="report-copy">
          <b>{{ source.title }}</b>
          <small>{{ resolver.webUrl(source) ? 'Web source' : 'Saved report reference' }}</small>
          <details class="report-location">
            <summary>Location</summary><p>{{ source.origin }}</p>
          </details>
          <p
            v-if="errors[source.num]"
            class="report-error"
            role="alert"
          >
            {{ errors[source.num] }}
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
          :disabled="busy.has(source.num)"
          @click="open(source)"
        >
          {{ busy.has(source.num) ? 'Opening…' : 'Read report' }} <span aria-hidden="true">↗</span>
        </button>
      </li>
    </ul>
  </details>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';

import { SupportingReportResolver } from '../../services/SupportingReportResolver';

import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { CitationMessage } from '../../models/Message';

const props = defineProps<{ msg: CitationMessage }>();
const resolver = new SupportingReportResolver(ipcRenderer);
const heading = computed(() => props.msg.sources.some(source => resolver.webUrl(source)) ? 'Sources and reports' : 'Supporting reports');
const busy = reactive(new Set<number>());
const errors = reactive<Record<number, string>>({});

async function open(source: CitationMessage['sources'][number]): Promise<void> {
  if (busy.has(source.num)) return;
  busy.add(source.num); delete errors[source.num];
  try {
    const file = await resolver.file(source);
    await resolver.verify(file);
    if (supportsDocumentEditor(file.path)) await openWorkspaceTab({ mode: 'paper', documentFile: file });
    else await openWorkspaceTab({ mode: 'files', title: source.title, filesNavigation: { ...file, section: 'detail' } });
  } catch (error) { errors[source.num] = error instanceof Error ? error.message : 'The report could not be opened. Please retry.' } finally { busy.delete(source.num) }
}
</script>

<style scoped>
.supporting-reports { margin: 12px 0; color: var(--text-secondary); font: 12px var(--font-body); }
.supporting-reports > summary { display: list-item; width: fit-content; cursor: pointer; padding: 5px 0; color: var(--text-muted); }
.supporting-reports > summary span { margin-left: 6px; font-variant-numeric: tabular-nums; }
ul { margin: 6px 0 0; padding: 0; list-style: none; max-width: 680px; }
.report-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-top: 1px solid var(--border-default); }
.report-icon { width: 18px; height: 20px; flex: none; margin-top: 1px; color: var(--text-muted); }
.report-copy { min-width: 0; flex: 1; }
.report-copy b { display: block; color: var(--text-primary); font-size: 13px; font-weight: 550; overflow-wrap: anywhere; }
.report-copy small { display: block; margin-top: 4px; color: var(--text-muted); }
.report-location { margin-top: 6px; font-size: 11px; }
.report-location summary { cursor: pointer; width: fit-content; }
.report-location p { overflow-wrap: anywhere; }
.report-row > button, .report-row > a { flex: none; padding: 5px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: transparent; color: var(--text-primary); font: inherit; cursor: pointer; text-decoration: none; }
.report-row > button:hover, .report-row > a:hover { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: .6; cursor: wait; }
summary:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.report-error { color: var(--status-error); margin: 8px 0 0; line-height: 1.5; }
@media (max-width: 480px) { .report-row { flex-wrap: wrap; } .report-row > button, .report-row > a { margin-left: 28px; } }
</style>
