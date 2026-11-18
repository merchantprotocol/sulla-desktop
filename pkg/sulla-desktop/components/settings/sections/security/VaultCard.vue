<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import SecurityCard from './SecurityCard.vue';
import PrefRow from '../../PrefRow.vue';
import type { SecuritySummary } from './types';
defineProps<{ vault: SecuritySummary['vault']; busy: boolean }>();
const emit = defineEmits<{ (event: 'lock'): void }>();
</script>
<template><SecurityCard title="Password vault" subtitle="Your passwords, API keys and sign-ins." icon="key" status="Encrypted" tone="good">
  <PrefRow v-if="vault" title="Vault" :subtitle="vault.locked ? 'Locked' : 'Unlocked'">
    <button v-if="!vault.locked" type="button" class="security-link" :disabled="busy" @click="emit('lock')">Lock now</button>
  </PrefRow>
  <PrefRow v-if="vault?.autoLockMinutes != null" title="Auto-lock" :subtitle="`Locks automatically after ${vault.autoLockMinutes} minutes idle`" />
  <p>Passwords and API keys never reach agents in plain text.</p>
</SecurityCard></template>
<style scoped>.security-link { color:var(--text-link); border:0; background:transparent; cursor:pointer; }</style>
