<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import PrefCard from '../../PrefCard.vue';
import PrefRow from '../../PrefRow.vue';
import type { SecuritySummary } from './types';
defineProps<{ approvals: SecuritySummary['approvals']; rules: SecuritySummary['rules'] }>();
</script>
<template><PrefCard title="Approvals &amp; agent rules" subtitle="Nothing new goes live without you, and agents follow the rules you set.">
  <PrefRow v-if="approvals?.pending != null" title="Waiting for approval" :subtitle="`${approvals.pending} waiting for you`" />
  <section v-if="rules !== null"><h3>Security Conscience rules</h3><p>Rules you wrote. Every agent must follow them.</p><p class="note">Rules can currently be managed through Sulla’s rules tools.</p><ul v-if="rules?.length"><li v-for="rule in rules" :key="rule.id">{{ rule.title }}</li></ul><p v-else>No rules yet.</p></section>
</PrefCard></template>
<style scoped>.note { color:var(--text-muted); }</style>
