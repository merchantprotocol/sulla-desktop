<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div class="listing-facts">
    <section v-if="row.description" class="description"><h2>What it does</h2><p>{{ row.description }}</p></section>
    <section v-if="row.requires_apps?.length"><h2>Works with</h2><span v-for="app in row.requires_apps" :key="app" class="chip">{{ app }}</span></section>
    <section v-if="row.approval_mode === 'drafts_only'"><h2>What it won't do on its own</h2><p>It drafts and asks you before acting</p></section>
    <button v-if="row.kind_label || row.kind" type="button" class="chip" @click="emit('filter', 'type', row.kind)">{{ row.kind_label || row.kind }}</button>
    <button v-if="row.topic || row.category" type="button" class="chip" @click="emit('filter', 'topic', row.topic || row.category)">{{ row.topic || row.category }}</button>
  </div>
</template>
<script setup lang="ts">
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';
defineProps<{ row: MarketplaceBrowseRow }>();
const emit = defineEmits<{ filter: [key: 'topic' | 'type', value: string] }>();
</script>
<style scoped>
.listing-facts{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}.listing-facts section{flex-basis:100%}.listing-facts h2{font-size:18px;margin:0 0 8px}.listing-facts p{margin:0}.chip{display:inline-flex;margin:0 6px 6px 0;cursor:pointer}.description{max-width:75ch}
</style>
