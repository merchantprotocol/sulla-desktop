<template>
  <span
    :class="['file-glyph', kind]"
    aria-hidden="true"
  >
    <svg
      v-if="kind === 'folder'"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
    <svg
      v-else-if="kind === 'image'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect
        x="4"
        y="5"
        width="16"
        height="14"
        rx="2"
      /><circle
        cx="9"
        cy="10"
        r="1.6"
      /><path d="M20 15l-4.5-4.5L7 19" />
    </svg>
    <svg
      v-else-if="kind === 'video'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect
        x="3"
        y="6"
        width="13"
        height="12"
        rx="2"
      /><path d="M16 10l5-3v10l-5-3z" />
    </svg>
    <svg
      v-else-if="kind === 'audio'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9 18V5l10-2v13" /><circle
        cx="6"
        cy="18"
        r="3"
      /><circle
        cx="16"
        cy="16"
        r="3"
      />
    </svg>
    <svg
      v-else-if="kind === 'code'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
    </svg>
    <svg
      v-else-if="kind === 'archive'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M6 3h12v18H6zM9 7h6M9 11h6" /><path d="M10 15h4v3h-4z" />
    </svg>
    <svg
      v-else
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5" /><path
        v-if="kind === 'pdf'"
        d="M9 17v-5h2a1.5 1.5 0 0 1 0 3H9"
      /><path
        v-else
        d="M9 13h6M9 17h6"
      />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name?: string; mime?: string; folder?: boolean }>();
const kind = computed(() => {
  if (props.folder) return 'folder';
  const mime = (props.mime ?? '').toLowerCase();
  const extension = (props.name?.split('.').pop() ?? '').toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(extension)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(extension)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(extension)) return 'audio';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'sh', 'html', 'css', 'json', 'yaml', 'yml'].includes(extension)) return 'code';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(extension)) return 'archive';
  return 'document';
});
</script>

<style scoped>
.file-glyph { width:30px;height:30px;border-radius:7px;display:grid;place-items:center;flex:none;color:var(--nx-accent-2);background:color-mix(in srgb,var(--nx-accent) 13%,transparent) }
.file-glyph svg { width:17px;height:17px }
.file-glyph.image { color:#b9a4ff;background:rgba(107,79,191,.16) }
.file-glyph.video,.file-glyph.pdf { color:#f0a45d;background:rgba(217,92,58,.13) }
.file-glyph.audio { color:#7ed7a8;background:rgba(31,157,85,.14) }
.file-glyph.code { color:var(--nx-read-2);background:color-mix(in srgb,var(--nx-read-3) 12%,transparent) }
.file-glyph.archive { color:var(--nx-read-3);background:color-mix(in srgb,var(--nx-read-3) 11%,transparent) }
.file-glyph.folder { color:var(--nx-accent-2);background:color-mix(in srgb,var(--nx-accent) 15%,transparent) }
</style>
