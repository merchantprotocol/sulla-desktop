<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import SecurityCard from './SecurityCard.vue';
import type { SecuritySummary } from './types';
defineProps<{ vault: SecuritySummary['vault'] }>();
</script>
<template><SecurityCard title="Protected areas" subtitle="Places agents can’t look into, ever." icon="eyeoff" status="Sealed" tone="good" wide>
  <PrefRow title="Vault material" subtitle="Agents can’t read, copy or export the vault itself. They use a credential only through Sulla, never the secret."><span class="status">Sealed</span></PrefRow>
</SecurityCard></template>
<style scoped>.status { color:var(--success); }</style>
