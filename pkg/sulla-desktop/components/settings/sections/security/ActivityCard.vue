<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import PrefCard from '../../PrefCard.vue';
import type { SecuritySummary } from './types';
defineProps<{ activity: SecuritySummary['activity'] }>();
const emit = defineEmits<{ (event: 'go'): void }>();
function time(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(); }
</script>
<template><PrefCard title="Agent activity" subtitle="What agents did to your files, websites and settings.">
  <div v-if="activity?.length" class="activity"><div v-for="(entry, index) in activity" :key="`${entry.at}-${index}`"><time>{{ time(entry.at) }}</time><span><strong>{{ entry.actor }}</strong> {{ entry.action }}<small>{{ entry.target }}</small></span></div></div>
  <p v-else-if="activity" class="empty">No recent activity.</p>
  <button v-if="activity !== null" type="button" class="security-link" @click="emit('go')">View audit log →</button>
</PrefCard></template>
<style scoped>.activity > div { display:flex; gap:14px; padding:9px 0; border-bottom:1px solid var(--border-muted); } time,.empty,small { color:var(--text-muted); } small { display:block; margin-top:3px; }.security-link { color:var(--text-link); border:0; background:transparent; cursor:pointer; }
</style>
