<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import SecurityCard from './SecurityCard.vue';
import type { SecuritySummary } from './types';
const props = defineProps<{ approvals: SecuritySummary['approvals']; rules: SecuritySummary['rules'] }>();
const approvalStatus = computed(() => props.approvals?.pending == null ? '' : props.approvals.pending ? `${props.approvals.pending} waiting` : 'All approved');
</script>
<template><SecurityCard title="Approvals &amp; agent rules" subtitle="Nothing new goes live without you, and agents follow the rules you set." icon="user" :status="approvalStatus" tone="good" wide>
  <section class="subsection"><h3>Waiting for approval</h3><p class="note">New agents, skills and workflows don’t go live until you approve them.</p><p v-if="approvals?.pending != null" class="fact">{{ approvals.pending }} waiting for you</p></section>
  <section class="subsection"><h3>Security Conscience rules</h3><p>Rules you wrote. Every agent must follow them.</p><p v-if="rules !== null" class="note">Rules can currently be managed through Sulla’s rules tools.</p><ul v-if="rules?.length"><li v-for="rule in rules" :key="rule.id">{{ rule.title }}</li></ul><p v-else-if="rules !== null">No rules yet.</p></section>
</SecurityCard></template>
<style scoped>.subsection{padding:14px 0}.subsection + .subsection{border-top:1px solid var(--border-muted)}.subsection h3{font-size:12px;margin:0 0 6px}.note{color:var(--text-muted);font-size:12px;margin:0}.fact{font-weight:600}</style>
