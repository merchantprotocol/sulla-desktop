<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The side dock's Results tab: what the agents in this chat produced, by
  outcome. Pinned messages, then what needs action, what is still open, and
  what shipped (with where it landed). Built from the result cards already in
  the chat; every item can jump back to its place in the transcript.
-->
<template>
  <div class="rs">
    <p
      v-if="empty"
      class="rs-empty"
    >
      No results yet. When agents finish, what they produced shows here.
    </p>

    <section
      v-if="groups.pinned.length"
      class="rs-sec"
    >
      <h3 class="rs-h">
        Pinned <span class="rs-n">{{ groups.pinned.length }}</span>
      </h3>
      <div
        v-for="pin in groups.pinned"
        :key="pin.messageId"
        class="rs-item"
      >
        <span class="rs-t">{{ pin.text }}</span>
        <button
          type="button"
          class="rs-jump"
          @click="jump(pin.messageId)"
        >
          Jump to
        </button>
      </div>
    </section>

    <section
      v-for="section in sections"
      :key="section.key"
      class="rs-sec"
    >
      <h3
        class="rs-h"
        :class="`rs-h-${section.key}`"
      >
        {{ section.title }} <span class="rs-n">{{ section.items.length }}</span>
      </h3>
      <div
        v-for="entry in section.items"
        :key="`${entry.item.jobId}:${entry.item.taskIndex}`"
        class="rs-item"
        :class="`rs-${section.key}`"
      >
        <span class="rs-t">{{ entry.item.label }}</span>
        <span class="rs-m">
          <template v-if="section.key === 'needsAction'">{{ activity(entry.item).kind === 'unknown' ? `Earlier report · ${entry.item.verdict}` : activity(entry.item).label }} · {{ WorkSteps.plainToolNames(shortenHashes(activity(entry.item).kind === 'unknown' ? entry.item.outcome : activity(entry.item).detail)) }}</template>
          <template v-else>{{ activity(entry.item).kind !== 'unknown' || entry.item.status !== 'completed' ? activity(entry.item).label : entry.item.verdict }} · {{ WorkSteps.plainToolNames(shortenHashes(entry.item.outcome)) }}</template>
        </span>
        <div class="rs-foot">
          <span
            v-if="refsOf(entry.item).length || environments(entry.item).length || ciOf(entry.item)"
            class="rs-tags"
          >
            <code
              v-for="ref in refsOf(entry.item)"
              :key="ref"
            >{{ ref }}</code>
            <span
              v-if="ciOf(entry.item)"
              class="rs-ci"
              :class="`rs-ci-${ciOf(entry.item)!.tone}`"
            >{{ ciOf(entry.item)!.text }}</span>
            <span
              v-for="env in environments(entry.item)"
              :key="env.name"
              class="rs-env"
              :class="`rs-env-${env.state}`"
            >{{ env.name }}<template v-if="env.state !== 'deployed'"> · {{ env.state }}</template></span>
          </span>
          <span class="rs-acts">
            <button
              v-if="activity(entry.item).decision"
              type="button"
              class="rs-jump"
              @click="viewQuestion(entry.item)"
            >{{ activity(entry.item).decision?.kind === 'approval' ? 'View approval' : 'View question' }}</button>
            <button
              v-if="followUp(entry.item)?.threadId"
              type="button"
              class="rs-jump"
              @click="viewFollowUp(entry.item)"
            >View follow-up</button>
            <button
              v-if="section.key === 'needsAction' && ['unknown', 'blocked'].includes(activity(entry.item).kind)"
              type="button"
              class="rs-jump"
              @click="resolve(entry.item)"
            >
              Draft follow-up
            </button>
            <button
              type="button"
              class="rs-jump"
              @click="jump(entry.messageId)"
            >
              Jump to
            </button>
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { AgentResultActions } from '../../composables/useAgentResultActions';
import { useResultActivity } from '../../composables/useResultActivity';
import { useChatController } from '../../controller/useChatController';
import { ciStateOf, environmentsOf, groupResults, shortenHashes } from '../../messages/sideDock';
import { WorkSteps } from '../../messages/workSteps';

import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

const controller = useChatController();
const { activity, rows } = useResultActivity();
/** Checks state for a PR result; only for work not yet shipped or failed. */
function ciOf(item: AgentResultItem) {
  if (item.merges?.length) return null;
  const target = activity(item).target;
  return ciStateOf(item, target ? [target] : rows.value.filter(row => row.jobId === item.jobId && row.taskIndex === item.taskIndex));
}
const resultActions = AgentResultActions.useAgentResultActions();

const groups = computed(() => groupResults(controller.messages.value, activity));
const sections = computed(() => [
  ...(groups.value.needsAction.length ? [{ key: 'needsAction', title: 'Reported issues', items: groups.value.needsAction }] : []),
  ...groups.value.sections,
]);
const empty = computed(() => !groups.value.pinned.length && !sections.value.length);

function refsOf(item: AgentResultItem): string[] {
  const merged = (item.merges ?? []).map(merge => (merge.sha ? `${ merge.pr } ${ merge.sha.slice(0, 7) }` : merge.pr));
  if (merged.length) return merged.slice(0, 3);
  return [item.change?.pr, item.change?.branch].filter((ref): ref is string => !!ref).slice(0, 2);
}
function environments(item: AgentResultItem) { return environmentsOf(item) }
function jump(messageId: string): void {
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}
function viewQuestion(item: AgentResultItem): void {
  const record = activity(item).decision;
  if (!record) return;
  const message = controller.messages.value.find(msg => (msg.kind === 'tool_question' && msg.questionId === record.id) || (msg.kind === 'tool_approval' && msg.approvalId === record.id));
  if (message) jump(message.id);
  else resultActions.openAgent({ threadId: record.conversationId, label: record.title });
}
function viewFollowUp(item: AgentResultItem): void {
  const target = followUp(item);
  if (target?.threadId) resultActions.openAgent({ threadId: target.threadId, label: 'Linked follow-up' });
}
function followUp(item: AgentResultItem) {
  const view = activity(item); const target = view.target ?? view.targetRef;
  return target && (target.jobId !== item.jobId || target.taskIndex !== item.taskIndex) ? target : undefined;
}
/** Drafts a message to Sulla about the problem; the user edits and sends it. */
function resolve(item: AgentResultItem): void {
  resultActions.draft(`Check the latest status of "${ item.label }" (job ${ item.jobId }, task ${ item.taskIndex }) and its linked follow-up work. Tell me who owns the next step and whether a real decision needs my answer. Do not duplicate work already being handled.`);
}
</script>

<style scoped src="../../styles/resultHistory.css" />
