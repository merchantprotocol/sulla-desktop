<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import SecurityCard from './SecurityCard.vue';
import PrefRow from '../../PrefRow.vue';
import type { SecuritySummary } from './types';
defineProps<{ threat: SecuritySummary['threat']; status: string }>();
const emit = defineEmits<{ (event: 'go'): void }>();
function time(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(); }
</script>
<template>
  <SecurityCard id="security-threat" title="Threat Protection" subtitle="Agent web traffic is scanned before it reaches them." icon="scan" :status="status" tone="good">
    <PrefRow title="Protection" :subtitle="status" />
    <PrefRow v-if="threat?.scannedToday != null" title="Requests scanned today" :subtitle="String(threat.scannedToday)" />
    <PrefRow v-if="threat?.blockedToday != null" title="Blocked today" :subtitle="String(threat.blockedToday)" />
    <div v-if="threat?.recentBlocked?.length" class="recent"><h3>Recently blocked</h3><div v-for="entry in threat.recentBlocked" :key="entry.host + entry.at" class="entry"><strong>{{ entry.host }}</strong><span>{{ entry.reason }}</span><time>{{ time(entry.at) }}</time></div></div>
    <button type="button" class="security-link" @click="emit('go')">Open Threat Protection settings →</button>
  </SecurityCard>
</template>
<style scoped>.recent { margin: 12px 0; } .entry { display:flex; flex-wrap:wrap; gap:8px; padding:8px 0; border-bottom:1px solid var(--border-muted); } .entry span { color:var(--text-muted); } .entry time { margin-left:auto; color:var(--text-muted); } .security-link { color:var(--text-link); border:0; background:transparent; cursor:pointer; }</style>
