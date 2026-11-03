<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name: string }>();

// 16px stroke icons, 1.5 stroke: the set in the approved model routing mockup.
const PATHS: Record<string, string> = {
  grip:  '<circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/>',
  up:    '<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>',
  down:  '<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>',
  x:     '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  chev:  '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  alert: '<path d="M8 2.5 14 13H2L8 2.5Z"/><path d="M8 6.5v3M8 11.2v.01"/>',
  info:  '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5.2v.01"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  plus:  '<path d="M8 3.5v9M3.5 8h9"/>',
};
const svg = computed(() => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ PATHS[props.name] ?? '' }</svg>`);
</script>

<template>
  <span
    class="mr-i"
    aria-hidden="true"
    v-html="svg"
  />
</template>
