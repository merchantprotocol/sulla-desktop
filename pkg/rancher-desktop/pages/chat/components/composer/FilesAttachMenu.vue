<template>
  <div v-if="open" class="files-attach-menu" role="menu" aria-label="Attach from Files">
    <button type="button" role="menuitem" @click="$emit('browse')"><span>◇</span><b>Attach from Files</b><kbd>⌘⇧F</kbd></button>
    <button type="button" role="menuitem" @click="$emit('upload')"><span>＋</span><b>Upload from Mac</b></button>
    <button type="button" role="menuitem" @click="$emit('screenshot')"><span>▣</span><b>Take a screenshot</b></button>
    <button type="button" role="menuitem" @click="$emit('record')"><span>●</span><b>{{ recording ? 'Stop recording' : 'Record screen' }}</b></button>
    <div v-if="recent.length" class="label">Recent in Files</div>
    <button v-for="file in recent" :key="`${file.fileId}:${file.versionId}`" type="button" role="menuitem" @click="$emit('choose', file)">
      <span>{{ file.mime.startsWith('image/') ? '▣' : file.mime.startsWith('video/') ? '▶' : '◇' }}</span><b class="file-name">{{ file.name }}</b><small>v{{ file.versionId.slice(0, 6) }}</small>
    </button>
  </div>
</template>

<script setup lang="ts">
export interface FilesReference {
  fileId:string; versionId:string; path:string; name:string; mime:string; size:number; updatedAt:string;
  createdByType?:string; createdById?:string; collectionId?:string; collectionKind?:string; agentRunId?:string;
}
defineProps<{ open:boolean; recent:FilesReference[]; recording:boolean }>();
defineEmits<{
  (e:'browse'):void; (e:'upload'):void; (e:'screenshot'):void; (e:'record'):void; (e:'choose', file:FilesReference):void;
}>();
</script>

<style scoped>
.files-attach-menu { position:absolute; left:12px; bottom:52px; z-index:30; width:300px; padding:6px; border:1px solid var(--nx-hair-strong); border-radius:10px; background:var(--nx-surface); box-shadow:0 20px 50px rgba(0,0,0,.45); }
button { width:100%; display:flex; align-items:center; gap:9px; padding:8px 9px; border:0; border-radius:7px; color:var(--nx-read-2); background:transparent; text-align:left; }
button:hover { background:color-mix(in srgb, var(--nx-accent) 13%, transparent); color:var(--nx-read-1); }
button > span { width:16px; color:var(--nx-accent-2); text-align:center; } button b { font:500 12px var(--font-mono, monospace); } button kbd, button small { margin-left:auto; color:var(--nx-read-4); font:10px var(--font-mono, monospace); }
.file-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .label { margin:5px 8px 2px; padding-top:7px; border-top:1px solid var(--nx-hair); color:var(--nx-read-4); font:9px var(--font-mono, monospace); text-transform:uppercase; letter-spacing:.1em; }
</style>
