<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template><div class="decision-reference"><span>{{ label }}</span><button type="button" @click="store.show(decisionId)">Open For You</button></div></template>
<script setup lang="ts">
import { computed } from 'vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import type { ToolApprovalMessage, ToolQuestionMessage } from '../../models/Message';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
const props = defineProps<{ msg: ToolApprovalMessage | ToolQuestionMessage }>();
const store = ChatDecisions.useChatDecisions();
const decisionId = computed(() => props.msg.kind === 'tool_question' ? props.msg.questionId : props.msg.approvalId);
const label = computed(() => { const id = decisionId.value; const record = store.decisions.value.find(item => item.id === id); return record ? `${ DecisionAttention.label(record, store.now.value) } · For You` : 'Request saved in For You'; });
</script>
<style scoped>.decision-reference{display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--text-secondary);font-size:12px;padding:5px 0}.decision-reference button{font:inherit;border:0;background:none;color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:3px}.decision-reference button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}</style>
