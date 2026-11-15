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
          <template v-if="section.key === 'needsAction'">{{ plainToolNames(shortenHashes(problemOf(entry.item))) }}</template>
          <template v-else>{{ entry.item.verdict }} · {{ plainToolNames(shortenHashes(entry.item.outcome)) }}</template>
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
              v-if="section.key === 'needsAction'"
              type="button"
              class="rs-jump"
              @click="resolve(entry.item)"
            >
              Resolve with Sulla
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
import { computed, inject } from 'vue';

import { useAgentResultActions } from '../../composables/useAgentResultActions';
import { useChatController } from '../../controller/useChatController';
import { ciStateOf, environmentsOf, groupResults, shortenHashes } from '../../messages/sideDock';
import { plainToolNames } from '../../messages/workSteps';

import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { findProblem, isSystemNote } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

const controller = useChatController();
const client = inject(AGENT_STATE_CLIENT_KEY, null);
/** Checks state for a PR result; only for work not yet shipped or failed. */
function ciOf(item: AgentResultItem) {
  if (item.merges?.length) return null;
  return ciStateOf(item, client?.snapshot.value.rows ?? []);
}
const resultActions = useAgentResultActions();

const groups = computed(() => groupResults(controller.messages.value));
const sections = computed(() => [
  ...(groups.value.needsAction.length ? [{ key: 'needsAction', title: 'Needs action', items: groups.value.needsAction }] : []),
  ...groups.value.sections,
]);
const empty = computed(() => !groups.value.pinned.length && !sections.value.length);

function refsOf(item: AgentResultItem): string[] {
  const merged = (item.merges ?? []).map(merge => (merge.sha ? `${ merge.pr } ${ merge.sha.slice(0, 7) }` : merge.pr));
  if (merged.length) return merged.slice(0, 3);
  return [item.change?.pr, item.change?.branch].filter((ref): ref is string => !!ref).slice(0, 2);
}
function environments(item: AgentResultItem) { return environmentsOf(item) }
/** What went wrong, in the agent's words; never Sulla's container housekeeping note. */
function problemOf(item: AgentResultItem): string {
  const recorded = isSystemNote(item.problem) ? undefined : item.problem;
  // A line lifted from a JSON report keeps its quotes and trailing comma: drop them.
  return (recorded || findProblem(item.report) || item.outcome).replace(/^\s*"|",?\s*$/g, '');
}
function jump(messageId: string): void {
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}
/** Drafts a message to Sulla about the problem; the user edits and sends it. */
function resolve(item: AgentResultItem): void {
  resultActions.draft(`${ item.label } ${ item.status === 'blocked' ? 'is blocked' : 'failed' }: ${ item.problem || item.outcome } Please work out how to resolve it.`);
}
</script>

<style scoped>
.rs {
  --rs-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --rs-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  padding: 6px 12px 12px;
}
.rs-empty { margin: 12px 2px; color: var(--rs-ink-3); font-size: 13px; }
.rs-sec { margin-top: 12px; }
.rs-h { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; color: var(--rs-ink-3); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.rs-h-needsAction { color: var(--status-error); }
.rs-h-shipped { color: var(--status-success); }
.rs-n { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--text-primary) 10%, transparent); color: var(--rs-ink-2); font-size: 11px; letter-spacing: 0; }
.rs-item {
  display: grid; gap: 4px; margin-bottom: 8px; padding: 10px 12px 10px;
  border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-page); font-size: 13px;
}
.rs-needsAction { border-color: color-mix(in srgb, var(--status-error) 50%, transparent); background: color-mix(in srgb, var(--status-error) 7%, var(--bg-page)); }
/* Title gets the full width and up to two lines, so the PR and round stay readable. */
.rs-t { color: var(--text-primary); font-weight: 650; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.rs-m { color: var(--rs-ink-2); font-size: 12.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
/* Footer: what it is (refs, CI, environments) on the left, what to do on the right; wraps as a whole row when narrow. */
.rs-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 4px; }
.rs-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-width: 0; }
.rs-tags code { padding: 2px 6px; border-radius: 5px; background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--rs-ink-2); font: 11.5px var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.rs-ci, .rs-env { display: inline-flex; align-items: center; min-height: 20px; padding: 1px 7px; border-radius: 5px; font-size: 11.5px; font-weight: 650; white-space: nowrap; }
.rs-ci { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.rs-ci-ok { background: color-mix(in srgb, var(--status-success) 15%, transparent); color: var(--status-success); }
.rs-ci-bad { background: color-mix(in srgb, var(--status-error) 15%, transparent); color: var(--status-error); }
.rs-env { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--rs-ink-3); }
.rs-env-deployed { background: color-mix(in srgb, var(--status-success) 15%, transparent); color: var(--status-success); }
.rs-env-failed { background: color-mix(in srgb, var(--status-error) 15%, transparent); color: var(--status-error); }
.rs-acts { display: flex; gap: 6px; margin-left: auto; }
.rs-jump {
  height: 26px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 7px; background: none;
  color: var(--rs-ink-2); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer;
}
.rs-jump:hover { border-color: var(--accent); color: var(--text-primary); }
.rs-jump:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
