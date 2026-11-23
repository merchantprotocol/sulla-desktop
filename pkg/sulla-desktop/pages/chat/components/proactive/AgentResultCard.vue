<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  What a finished background agent did, shaped by what it was for (merge,
  QA run, review, fix, or anything else). Nothing consequential happens from
  here: buttons open things, copy text, or draft a message the user sends.
-->
<template>
  <article
    class="ar"
    :class="{ 'ar-group': items.length > 1, 'ar-standard': standard }"
    aria-label="Background agent result"
  >
    <header
      v-if="items.length > 1"
      class="ar-grouphead"
    >
      <b>{{ items.length }} agents finished</b><span>{{ groupSummary }}</span>
    </header>

    <section
      v-for="(item, index) in items"
      :key="`${item.jobId}:${item.taskIndex}`"
      class="ar-item"
      :class="{ 'ar-open': isOpen(index) }"
    >
      <div
        v-if="isHandled(item)"
        class="ar-handled"
      >
        <span class="ar-chip ar-dim">Hidden on this device</span>
        <span class="ar-handled-title">{{ item.label }}</span>
        <button
          type="button"
          class="ar-btn ar-quiet"
          @click="setHandled(item, false)"
        >
          Undo
        </button>
      </div>
      <div
        v-else
        class="ar-head"
        :role="isExpandable ? 'button' : undefined"
        :tabindex="isExpandable ? 0 : undefined"
        :aria-expanded="isExpandable ? isOpen(index) : undefined"
        :aria-label="isExpandable ? `${isOpen(index) ? 'Collapse' : 'Expand'} result details for ${item.label}` : undefined"
        @click="isExpandable && toggle(index)"
        @keydown.enter.prevent="isExpandable && toggle(index)"
        @keydown.space.prevent="isExpandable && toggle(index)"
      >
        <span
          class="ar-chip"
          :class="`ar-${showCurrent(item) ? activityTone(item) : item.tone}`"
        ><span class="ar-dot" />{{ activity(item).kind === 'unknown' && needsAttention(item) ? 'Earlier report' : showCurrent(item) ? activity(item).label : item.verdict }}</span>
        <span class="ar-title">
          <b>{{ item.label }}</b>
          <span>{{ byline(item) }}</span>
        </span>
        <span
          v-if="kindOf(item) || when?.label"
          class="ar-kind"
          :title="when?.full"
        >{{ [kindOf(item), when?.label].filter(Boolean).join(' ') }}</span>
        <span
          v-if="items.length > 1"
          class="ar-chev"
          aria-hidden="true"
        >⌄</span>
      </div>

      <template v-if="isOpen(index) && !isHandled(item)">
        <p
          v-if="activity(item).kind !== 'unknown'"
          class="ar-whonext"
          aria-live="polite"
        >
          {{ activity(item).detail }}
        </p>
        <p
          v-else-if="needsAttention(item)"
          class="ar-history-note"
        >
          This records an earlier attempt, not a request for your answer. See Results for current work in this chat.
        </p>
        <component
          :is="needsAttention(item) ? 'details' : 'div'"
          :class="{ 'ar-original': needsAttention(item) }"
        >
          <summary v-if="needsAttention(item)">
            Original report · {{ item.verdict }}
          </summary>
          <p
            v-if="problemOf(item)"
            class="ar-problem"
          >
            <b>Reported then:</b> {{ shortenHashes(problemOf(item) ?? '') }}
          </p>
          <p class="ar-outcome">
            {{ shortenHashes(item.outcome) }}
          </p>
          <AgentResultBody
            :item="item"
            :expanded="expandedKinds(index)"
            @expand="kind => expand(index, kind)"
          />
        </component>

        <div class="ar-acts">
          <button
            v-for="link in (item.links ?? []).slice(0, 2)"
            :key="link.url"
            type="button"
            class="ar-btn"
            :title="link.url"
            @click="actions.openUrl(link.url)"
          >
            {{ link.label }}
          </button>
          <button
            v-if="item.threadId"
            type="button"
            class="ar-btn"
            @click="openAgent(item)"
          >
            Open agent
          </button>
          <button
            type="button"
            class="ar-btn ar-quiet"
            @click="copyReport(item)"
          >
            {{ copied === itemKey(item) ? 'Copied' : 'Copy report' }}
          </button>
          <button
            v-if="activity(item).decision"
            type="button"
            class="ar-btn ar-pri"
            @click="openDecision(item)"
          >
            {{ activity(item).decision?.kind === 'approval' ? 'View approval' : 'View question' }}
          </button>
          <button
            v-if="followUp(item)?.threadId"
            type="button"
            class="ar-btn"
            @click="openFollowUp(item)"
          >
            View follow-up
          </button>
          <button
            v-if="needsAttention(item)"
            type="button"
            class="ar-btn ar-quiet"
            @click="setHandled(item, true)"
          >
            Hide report
          </button>
          <span class="ar-sp" />
          <button
            v-for="step in stepsFor(item)"
            :key="step.label"
            type="button"
            class="ar-btn"
            :class="{ 'ar-pri': step.primary }"
            :title="`Puts this in the message box for you to send: ${step.prompt}`"
            @click="actions.draft(step.prompt)"
          >
            {{ step.label }}
          </button>
        </div>
        <p
          v-if="notice[itemKey(item)]"
          class="ar-notice"
          role="status"
        >
          {{ notice[itemKey(item)] }}
        </p>

        <!-- Technical details, one click away instead of repeated in every row. -->
        <details class="ar-raw">
          <summary>Details · job, model, thread, full report</summary>
          <dl class="ar-kv">
            <template
              v-for="fact in factsOf(item)"
              :key="fact.label"
            >
              <dt>{{ fact.label }}</dt>
              <dd>{{ fact.value }}</dd>
              <button
                v-if="fact.copy"
                type="button"
                class="ar-copy"
                :aria-label="`Copy ${fact.label.toLowerCase()}`"
                @click="copyFact(item, fact)"
              >
                {{ copied === `${itemKey(item)}:${fact.label}` ? 'Copied' : 'Copy' }}
              </button>
              <span v-else />
            </template>
          </dl>
          <details
            v-if="item.report"
            class="ar-report"
          >
            <summary>Full report · {{ wordCount(item.report) }} words</summary>
            <pre>{{ item.report }}</pre>
          </details>
        </details>
      </template>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';

import AgentResultBody from './AgentResultBody.vue';
import { AgentResultActions } from '../../composables/useAgentResultActions';
import { useResultActivity } from '../../composables/useResultActivity';
import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import { shortenHashes } from '../../messages/sideDock';

import { PURPOSE_LABEL, findProblem, isSystemNote } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentResultCardData, AgentResultItem, AgentResultTone } from '@pkg/shared/agentResults/AgentResultCard';
import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';

const props = withDefaults(defineProps<{ data: AgentResultCardData; messageId?: string; standard?: boolean }>(), { standard: false });
const lineTime = LineTimes.useLineTime();
const when = computed(() => (props.messageId ? lineTime(props.messageId) : undefined));
/** "Finished" would contradict a Blocked or Failed chip, so it shows only for completed work. */
function kindOf(item: AgentResultItem): string {
  return item.purpose !== 'other' || item.status === 'completed' ? PURPOSE_LABEL[item.purpose] : '';
}
const actions = AgentResultActions.useAgentResultActions();
const { activity } = useResultActivity();
let controller: ReturnType<typeof useChatController> | undefined;
try { controller = useChatController() } catch { /* outside a chat page */ }

const ATTENTION: AgentResultTone[] = ['bad', 'warn'];

const items = computed(() => props.data.items ?? []);
const open = reactive(new Set<number>(props.standard ? [] : firstOpen()));
const more = reactive(new Set<string>());
const notice = reactive<Record<string, string>>({});
const copied = ref('');

const groupSummary = computed(() => {
  const attention = items.value.filter(item => ATTENTION.includes(item.tone)).length;
  const fine = items.value.length - attention;
  return [fine && `${ fine } done`, attention && `${ attention } reported issue${ attention === 1 ? '' : 's' }`].filter(Boolean).join(' · ');
});

/** Detailed mode opens a single item or the first item needing attention; Standard starts compact. */
function firstOpen(): number[] {
  const list = props.data.items ?? [];
  if (list.length <= 1) return [0];
  const attention = list.findIndex(item => ATTENTION.includes(item.tone));
  return [attention >= 0 ? attention : 0];
}
const isExpandable = computed(() => props.standard || items.value.length > 1);
function isOpen(index: number): boolean { return props.standard ? open.has(index) : items.value.length === 1 || open.has(index) }
function toggle(index: number): void { if (open.has(index)) open.delete(index); else open.add(index); }
watch(() => props.standard, standard => {
  if (standard) open.clear();
  else if (!open.size) firstOpen().forEach(index => open.add(index));
});
function itemKey(item: AgentResultItem): string { return `${ item.jobId }:${ item.taskIndex }` }

/** The lists ("merges", "findings") shown in full for the item at `index`; kept while the item is closed. */
function expandedKinds(index: number): string[] {
  return [...more].filter(key => key.startsWith(`${ index }:`)).map(key => key.slice(`${ index }:`.length));
}
function expand(index: number, kind: string): void { more.add(`${ index }:${ kind }`) }

function byline(item: AgentResultItem): string {
  const model = props.standard ? '' : AgentModelStatus.label(item.modelStatus ?? (item.model ? { model: item.model, effort: null, source: 'requested' } : undefined));
  return [item.agentId, model, item.durationMs ? duration(item.durationMs) : ''].filter(Boolean).join(' · ');
}
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${ Math.max(1, Math.round(ms / 1000)) }s`;
  if (minutes < 60) return `${ minutes }m`;
  return `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`;
}

// ── 1 · The problem, from the card or, for older cards, the report ──
function problemOf(item: AgentResultItem): string | undefined {
  if (item.status === 'completed') return undefined;
  // The card already labels it "Blocked:" or "Failed:"; drop the agent's own label.
  // A recorded problem that is only Sulla's housekeeping note says nothing about what went wrong.
  const recorded = isSystemNote(item.problem) ? undefined : item.problem;
  return (recorded || findProblem(item.report))?.replace(/^\[?(blocker|blocked|error|failed)\]?\s*[:\-–]?\s*/i, '');
}
function needsAttention(item: AgentResultItem): boolean {
  return item.status !== 'completed' || ATTENTION.includes(item.tone);
}

function activityTone(item: AgentResultItem): AgentResultTone {
  const kind = activity(item).kind;
  return kind === 'needsYou' || kind === 'blocked' ? 'warn' : kind === 'unknown' ? 'dim' : 'info';
}
function showCurrent(item: AgentResultItem): boolean { return needsAttention(item) || activity(item).kind !== 'unknown' }
function openDecision(item: AgentResultItem): void {
  const record = activity(item).decision;
  if (!record) return;
  const message = controller?.messages.value.find(msg => (msg.kind === 'tool_question' && msg.questionId === record.id) || (msg.kind === 'tool_approval' && msg.approvalId === record.id));
  if (message) window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId: message.id } }));
  else actions.openAgent({ threadId: record.conversationId, label: record.title });
}
function openFollowUp(item: AgentResultItem): void {
  const target = followUp(item);
  if (target?.threadId) actions.openAgent({ threadId: target.threadId, label: 'Linked follow-up' });
}
function followUp(item: AgentResultItem) {
  const view = activity(item); const target = view.target ?? view.targetRef;
  return target && (target.jobId !== item.jobId || target.taskIndex !== item.taskIndex) ? target : undefined;
}

// ── 3 · Main buttons by state; each only drafts a message ──
function stepsFor(item: AgentResultItem): { label: string; prompt: string; primary: boolean }[] {
  const current = activity(item);
  if (['working', 'waiting', 'needsYou', 'completed'].includes(current.kind)) return [];
  if (needsAttention(item)) {
    return [{ label: 'Draft status check', primary: false, prompt: `Check the latest status of "${ item.label }" (job ${ item.jobId }, task ${ item.taskIndex }) and its linked follow-up work. Tell me who owns the next step and whether a real decision needs my answer. Do not duplicate work already being handled.` }];
  }
  return item.next ? [{ label: item.next.label, primary: true, prompt: item.next.prompt }] : [];
}

// ── 4 · Mark handled: a per-viewer note in this browser, never sent to Sulla ──
const HANDLED_KEY = 'sulla.agentResults.handled';
const handled = reactive(new Set<string>(readHandled()));
function readHandled(): string[] {
  try { return JSON.parse(localStorage.getItem(HANDLED_KEY) || '[]') } catch { return [] }
}
function isHandled(item: AgentResultItem): boolean { return handled.has(itemKey(item)) }
function setHandled(item: AgentResultItem, value: boolean): void {
  if (value) handled.add(itemKey(item)); else handled.delete(itemKey(item));
  try { localStorage.setItem(HANDLED_KEY, JSON.stringify([...handled].slice(-500))) } catch { /* convenience only */ }
}

// ── Details: the technical facts, each copyable where useful ──
interface Fact { label: string; value: string; copy?: string }
function factsOf(item: AgentResultItem): Fact[] {
  const facts: Fact[] = [{ label: 'Job', value: `${ item.jobId } · task ${ item.taskIndex }`, copy: item.jobId }];
  const model = props.standard ? '' : AgentModelStatus.label(item.modelStatus ?? (item.model ? { model: item.model, effort: null, source: 'requested' } : undefined));
  const agent = [item.agentId, model].filter(Boolean).join(' · ');
  if (agent) facts.push({ label: props.standard ? 'Agent' : 'Agent · model', value: agent });
  const ran = [item.startedAt && item.endedAt ? `${ clockTime(item.startedAt) } → ${ clockTime(item.endedAt) }` : '', item.durationMs ? `(${ duration(item.durationMs) })` : '', item.runLocation === 'container' ? '· container' : item.runLocation === 'vm' ? '· host' : ''].filter(Boolean).join(' ');
  if (ran) facts.push({ label: 'Ran', value: ran });
  if (item.threadId) facts.push({ label: 'Thread', value: item.threadId, copy: item.threadId });
  if (item.workspace) facts.push({ label: 'Workspace', value: item.workspace, copy: item.workspace });
  return facts;
}
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${ d.getHours() }:${ String(d.getMinutes()).padStart(2, '0') }`;
}
function wordCount(text: string): string { return text.trim().split(/\s+/).length.toLocaleString() }
async function copyFact(item: AgentResultItem, fact: Fact): Promise<void> {
  if (!fact.copy || !await actions.copy(fact.copy)) return;
  const key = `${ itemKey(item) }:${ fact.label }`;
  copied.value = key;
  setTimeout(() => { if (copied.value === key) copied.value = ''; }, 2000);
}

function openAgent(item: AgentResultItem): void {
  if (!actions.openAgent(item)) flash(item, 'Could not open this agent\'s conversation here.');
}
async function copyReport(item: AgentResultItem): Promise<void> {
  if (!await actions.copy(item.report)) { flash(item, 'Could not copy the report.'); return }
  copied.value = itemKey(item);
  setTimeout(() => { if (copied.value === itemKey(item)) copied.value = ''; }, 2000);
}
function flash(item: AgentResultItem, text: string): void {
  const key = itemKey(item);
  notice[key] = text;
  setTimeout(() => { if (notice[key] === text) delete notice[key]; }, 4000);
}
</script>

<style scoped src="../../styles/agent-result-card.css"></style>
