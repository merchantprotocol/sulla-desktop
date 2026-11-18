<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import SecurityCard from './SecurityCard.vue';
import PrefRow from '../../PrefRow.vue';
import type { SecuritySummary } from './types';
defineProps<{ vault: SecuritySummary['vault'] }>();
const emit = defineEmits<{ (event: 'go'): void }>();
</script>
<template><SecurityCard title="File encryption" subtitle="Sulla Files, on this Mac and in the cloud." icon="file" status="Encrypted" tone="good">
  <PrefRow title="Stored file contents encrypted" subtitle="AES-256-GCM, for every file you keep in Sulla Files."><span class="status">On</span></PrefRow>
  <PrefRow v-if="vault" title="Cloud copies open only after you unlock your vault" :subtitle="vault?.locked ? 'Unlock your vault to open cloud copies.' : 'Your vault is unlocked, so cloud copies are readable right now.'" />
  <PrefRow title="Version history and audit trail" subtitle="Every change is versioned and shows who made it — restore anything."><button type="button" class="security-link" @click="emit('go')">Open Files to view version history →</button></PrefRow>
</SecurityCard></template>
<style scoped>.security-link { color:var(--text-link); border:0; background:transparent; cursor:pointer; } .status { color:var(--success); }</style>
