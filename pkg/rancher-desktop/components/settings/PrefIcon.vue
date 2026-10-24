<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name: string }>();

// 24px line icons, 1.8 stroke: the same set as the Files and Agents screens.
const PATHS: Record<string, string> = {
  search:  '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun:     '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:    '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  user:    '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  folder:  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  shield:  '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  box:     '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  helm:    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v5.5M12 14.5V20M4 12h5.5M14.5 12H20M6.3 6.3l4 4M13.7 13.7l4 4M17.7 6.3l-4 4M10.3 13.7l-4 4"/>',
  spark:   '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  face:    '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  heart:   '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  flow:    '<rect x="3" y="4" width="7" height="5" rx="1.5"/><rect x="14" y="15" width="7" height="5" rx="1.5"/><path d="M6.5 9v3a3 3 0 0 0 3 3h4.5"/>',
  mic:     '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  paint:   '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" opacity=".35"/>',
  wrench:  '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8M14.7 6.3 13 4.6a4 4 0 0 0-5.6 5.6l1.7 1.7"/>',
  app:     '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  play:    '<path d="M7 4v16l13-8z"/>',
  stop:    '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  chev:    '<path d="m9 6 6 6-6 6"/>',
  check:   '<path d="m5 12 5 5 9-10"/>',
  doc:     '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  plus:    '<path d="M12 5v14M5 12h14"/>',
  power:   '<path d="M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  alert:   '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  trash:   '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

const svg = computed(() => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ PATHS[props.name] ?? '' }</svg>`);
</script>

<template>
  <span
    class="pi"
    aria-hidden="true"
    v-html="svg"
  />
</template>
