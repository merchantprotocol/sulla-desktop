<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      v-for="(d, i) in paths"
      :key="i"
      :d="d"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

// Stroke icons for the workflows list (trigger kinds, locations, actions).
const ICONS: Record<string, string[]> = {
  workflow:  ['M4.5 4h3A1.5 1.5 0 0 1 9 5.5v2A1.5 1.5 0 0 1 7.5 9h-3A1.5 1.5 0 0 1 3 7.5v-2A1.5 1.5 0 0 1 4.5 4z', 'M16.5 4h3A1.5 1.5 0 0 1 21 5.5v2A1.5 1.5 0 0 1 19.5 9h-3A1.5 1.5 0 0 1 15 7.5v-2A1.5 1.5 0 0 1 16.5 4z', 'M10.5 15h3a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 18.5v-2a1.5 1.5 0 0 1 1.5-1.5z', 'M6 9v1.5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9M12 12.5V15'],
  play:      ['M8 5.5v13l10-6.5z'],
  more:      ['M5 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4zM12 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4zM19 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4z'],
  search:    ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-4-4'],
  schedule:  ['M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M4 10h16M8 3v4M16 3v4'],
  manual:    ['M6 3l13 7-5.5 1.8L11.5 18z'],
  chat:      ['M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z'],
  calendar:  ['M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M4 10h16M8 3v4M16 3v4M8 14h3'],
  heartbeat: ['M3 12h4l2-5 4 10 2-5h6'],
  none:      ['M6 12h12'],
  desktop:   ['M5 5h14a1 1 0 0 1 1 1v9H4V6a1 1 0 0 1 1-1z', 'M2 18.5h20'],
  server:    ['M5 4h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 14h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z', 'M7.5 6.3a.7.7 0 1 0 0 1.4a.7.7 0 1 0 0-1.4zM7.5 16.3a.7.7 0 1 0 0 1.4a.7.7 0 1 0 0-1.4z'],
};

const props = defineProps<{ name: string }>();
const paths = computed(() => ICONS[props.name] ?? ICONS.none);
</script>
