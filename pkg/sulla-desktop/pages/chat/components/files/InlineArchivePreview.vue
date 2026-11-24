<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="archive-preview" role="group" :aria-label="'Archive contents for ' + name">
    <ul>
      <li v-for="entry in visibleEntries" :key="entry.name">
        <FileGlyph :name="entry.name" />
        <span class="entry-name" :title="entry.name">{{ entry.name }}</span>
        <small v-if="entry.sizeLabel">{{ entry.sizeLabel }}</small>
      </li>
    </ul>
    <p v-if="remainingEntries > 0" class="archive-more">
      {{ remainingEntries }} more {{ remainingEntries === 1 ? 'item' : 'items' }} in this archive
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import FileGlyph from './FileGlyph.vue';
import type { InlineArchiveEntryPreview } from './inlineFilePreview';

const props = defineProps<{
  name: string;
  entries: readonly InlineArchiveEntryPreview[];
  totalEntries: number;
}>();

const visibleEntries = computed(() => props.entries.slice(0, 4));
const remainingEntries = computed(() => Math.max(0, props.totalEntries - visibleEntries.value.length));
</script>

<style scoped>
.archive-preview { min-width: 0; padding: 4px 12px 8px; }
.archive-preview ul { margin: 0; padding: 0; list-style: none; }
.archive-preview li { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.archive-preview :deep(.file-glyph) { width: 18px; height: 18px; border-radius: 4px; }
.archive-preview :deep(.file-glyph svg) { width: 12px; height: 12px; }
.entry-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font: 11.5px var(--font-body); }
.archive-preview small { flex: none; color: var(--text-muted); font: 10.5px var(--font-body); }
.archive-more { margin: 4px 0 0 26px; color: var(--text-muted); font-size: 11px; }
</style>
