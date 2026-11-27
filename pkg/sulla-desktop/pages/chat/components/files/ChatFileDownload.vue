<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <span class="chat-file-download">
    <button
      type="button"
      :aria-label="'Download ' + name"
      :title="'Download ' + name"
      :disabled="action.state.busy"
      @click.stop="action.download(name, versionId)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v11M7 11l5 5 5-5M4 19h16" /></svg>
      <span v-if="!iconOnly">Download</span>
    </button>
    <span v-if="action.state.error" class="download-error" role="alert" @click.stop>{{ action.state.error }}</span>
  </span>
</template>

<script setup lang="ts">
import { FileDownloadAction } from '@pkg/pages/files/FileDownloadAction';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ fileId: string | (() => Promise<string>); name: string; versionId?: string; iconOnly?: boolean }>();
const action = FileDownloadAction.forIpc(ipcRenderer, () => typeof props.fileId === 'string' ? props.fileId : props.fileId());
</script>

<style scoped>
.chat-file-download { min-width: 0; display: inline-flex; flex-direction: column; align-items: flex-start; }
button { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border: 1px solid var(--border-default); border-radius: 6px; background: transparent; color: var(--text-secondary); font: 500 11.5px var(--font-body); }
button:not(:disabled):hover { border-color: var(--accent); color: var(--text-primary); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: .6; }
svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.download-error { max-width: 22em; color: var(--status-error); font-size: 12px; overflow-wrap: anywhere; }
</style>
