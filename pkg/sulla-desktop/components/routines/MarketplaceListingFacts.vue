<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div class="listing-facts">
    <section
      v-if="row.description"
      class="facts-block description"
    >
      <h3>What it does</h3>
      <p>{{ row.description }}</p>
    </section>

    <section
      v-if="row.requires_apps?.length"
      class="facts-block"
    >
      <h3>Works with</h3>
      <span
        v-for="app in row.requires_apps"
        :key="app"
        class="chip"
      >{{ app }}</span>
    </section>

    <section
      v-if="row.approval_mode === 'drafts_only'"
      class="facts-block"
    >
      <h3>What it won't do on its own</h3>
      <p>It drafts and asks you before acting</p>
    </section>

    <section
      v-if="typeLabel || topicValue"
      class="facts-block"
      role="group"
      aria-label="Browse related listings"
    >
      <h3>Browse related</h3>
      <div class="chip-row">
        <button
          v-if="typeLabel"
          type="button"
          class="chip"
          :aria-label="`Show all ${typeLabel} listings`"
          @click="emit('filter', 'type', row.kind)"
        >
          {{ typeLabel }}
        </button>
        <button
          v-if="topicValue"
          type="button"
          class="chip"
          :aria-label="`Show all ${topicValue} use cases`"
          @click="emit('filter', 'topic', topicValue)"
        >
          {{ topicValue }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

const props = defineProps<{ row: MarketplaceBrowseRow }>();
const emit = defineEmits<{ filter: [key: 'topic' | 'type', value: string] }>();

const typeLabel = computed(() => props.row.kind_label || props.row.kind || '');
const topicValue = computed(() => props.row.topic || props.row.category || '');
</script>

<style scoped>
.listing-facts {
  display: flex;
  flex-direction: column;
  gap: 24px;
  margin: 24px 0;
}

.facts-block h3 {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-300, var(--text-muted, #555));
  margin: 0 0 12px;
}

.facts-block p {
  margin: 0;
}

.description {
  max-width: 75ch;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 13px;
  border: 0;
  border-radius: 999px;
  background: var(--surface-2, #f3f4f4);
  color: var(--text-muted, #555);
  font-size: 13px;
  margin: 0 6px 6px 0;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

button.chip:hover {
  background: var(--accent-dim, #e4eff3);
  color: var(--accent, #397f99);
}

button.chip:focus-visible {
  outline: 2px solid var(--accent, #397f99);
  outline-offset: 2px;
}
</style>
