<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import PrefCard from '../../PrefCard.vue';
import PrefRow from '../../PrefRow.vue';
import type { SecuritySummary } from './types';
defineProps<{ vault: SecuritySummary['vault'] }>();
</script>
<template><PrefCard title="Protected areas" subtitle="Places agents can’t look into, ever.">
  <PrefRow v-if="vault" title="Vault material" subtitle="Agents can’t read, copy or export the vault itself. They use a credential only through Sulla, never the secret."><span class="status">Sealed</span></PrefRow>
</PrefCard></template>
<style scoped>.status { color:var(--success); }</style>
