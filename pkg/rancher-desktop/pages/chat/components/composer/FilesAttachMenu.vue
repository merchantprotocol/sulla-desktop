<template>
  <div
    v-if="open"
    class="files-attach-menu"
    role="menu"
    aria-label="Add attachment"
  >
    <button
      type="button"
      role="menuitem"
      @click="$emit('browse')"
    >
      <svg
        class="menu-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg><b>Attach from Files</b><kbd>⌘⇧F</kbd>
    </button>
    <button
      type="button"
      role="menuitem"
      :disabled="uploading"
      @click="$emit('upload')"
    >
      <svg
        class="menu-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M12 16V5M7 10l5-5 5 5M4 19h16" /></svg><b>{{ uploading ? 'Uploading…' : 'Upload from Mac' }}</b>
    </button>
    <button
      type="button"
      role="menuitem"
      @click="$emit('screenshot')"
    >
      <svg
        class="menu-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M4 8h3l2-2.5h6L17 8h3v11H4z" /><circle
        cx="12"
        cy="13"
        r="3.2"
      /></svg><b>Take a screenshot</b>
    </button>
    <button
      type="button"
      role="menuitem"
      @click="$emit('record')"
    >
      <svg
        class="menu-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><rect
        x="3"
        y="5"
        width="18"
        height="13"
        rx="2"
      /><path d="M8 21h8" /><circle
        cx="12"
        cy="11.5"
        r="2.5"
        fill="currentColor"
        stroke="none"
      /></svg><b>{{ recording ? 'Stop recording' : 'Record screen' }}</b>
    </button>
    <div
      v-if="recent.length"
      class="label"
    >
      Recent in Files
    </div>
    <button
      v-for="file in recent"
      :key="`${file.fileId}:${file.versionId}`"
      type="button"
      role="menuitem"
      @click="$emit('choose', file)"
    >
      <FileGlyph
        :name="file.name"
        :mime="file.mime"
      /><b class="file-name">{{ file.name }}</b><FileStatusIcon />
    </button>
    <p
      v-if="uploadError"
      class="upload-error"
      role="alert"
    >
      {{ uploadError }}
    </p>
  </div>
</template>

<script setup lang="ts">
import FileGlyph from '../files/FileGlyph.vue';
import FileStatusIcon from '../files/FileStatusIcon.vue';

export interface FilesReference {
  fileId:          string;
  versionId?:      string;
  path:            string;
  name:            string;
  mime:            string;
  size:            number;
  updatedAt:       string;
  createdByType?:  string;
  createdById?:    string;
  collectionId?:   string;
  collectionKind?: string;
  agentRunId?:     string;
}
defineProps<{ open: boolean; recent: FilesReference[]; recording: boolean; uploading?: boolean; uploadError?: string }>();
defineEmits<{
  (e:'browse'):void; (e:'upload'):void; (e:'screenshot'):void; (e:'record'):void; (e:'choose', file:FilesReference):void;
}>();
</script>

<style scoped>
.files-attach-menu { position:absolute; left:12px; bottom:52px; z-index:30; width:260px; max-width:calc(100% - 24px); box-sizing:border-box; padding:6px; border:1px solid var(--nx-hair-strong); border-radius:10px; background:var(--nx-surface); box-shadow:var(--nx-shadow-lg); }
button { width:100%; display:flex; align-items:center; gap:9px; padding:7px 9px; border:0; border-radius:7px; color:var(--nx-read-2); background:transparent; text-align:left; }
button:hover { background:color-mix(in srgb, var(--nx-accent) 13%, transparent); color:var(--nx-read-1); }
button:disabled { cursor:progress; opacity:.62; }
button .menu-icon { width:14px;height:14px;flex:none;color:var(--nx-read-3) } button b { font:500 12.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; } button kbd, button small { margin-left:auto; color:var(--nx-read-4); font:10px var(--font-mono, monospace); }
button :deep(.file-glyph) { width:20px;height:20px;border-radius:5px }
button :deep(.file-glyph svg) { width:11px;height:11px }
.file-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .label { margin:5px 8px 2px; padding-top:7px; border-top:1px solid var(--nx-hair); color:var(--nx-read-4); font:600 10.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif; text-transform:uppercase; letter-spacing:.1em; }
.upload-error { margin:5px 8px 3px; color:var(--nx-danger, var(--nx-read-2)); font:10px/1.4 var(--font-mono, monospace); }
</style>
