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
    :class="{ 'ar-group': items.length > 1 }"
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
        <span class="ar-chip ar-dim">Handled</span>
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
        :role="items.length > 1 ? 'button' : undefined"
        :tabindex="items.length > 1 ? 0 : undefined"
        :aria-expanded="items.length > 1 ? isOpen(index) : undefined"
        @click="items.length > 1 && toggle(index)"
        @keydown.enter.prevent="items.length > 1 && toggle(index)"
        @keydown.space.prevent="items.length > 1 && toggle(index)"
      >
        <span
          class="ar-chip"
          :class="`ar-${item.tone}`"
        ><span class="ar-dot" />{{ item.verdict }}</span>
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
        <!-- 1 · Blocked or failed: the problem leads; progress is secondary. -->
        <p
          v-if="problemOf(item)"
          class="ar-problem"
          :class="{ 'ar-failed': item.status !== 'blocked' }"
        >
          <b>{{ item.status === 'blocked' ? 'Blocked' : 'Failed' }}:</b> {{ shortenHashes(problemOf(item) ?? '') }}
        </p>
        <p
          class="ar-outcome"
          :class="{ 'ar-secondary': problemOf(item) }"
        >
          {{ shortenHashes(item.outcome) }}
        </p>
        <!-- 2 · Whose move it is. -->
        <p
          v-if="needsAttention(item)"
          class="ar-whonext"
        >
          {{ whoNext }}
        </p>
        <!-- 5 · Where the agent ended up. -->
        <ul
          v-if="tailOf(item).length"
          class="ar-tail"
          aria-label="End of the agent's report"
        >
          <li
            v-for="(line, li) in tailOf(item)"
            :key="li"
          >
            {{ shortenHashes(line) }}
          </li>
        </ul>

        <AgentResultBody
          :item="item"
          :expanded="expandedKinds(index)"
          @expand="kind => expand(index, kind)"
        />

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
            v-if="needsAttention(item)"
            type="button"
            class="ar-btn ar-quiet"
            @click="setHandled(item, true)"
          >
            Mark handled
          </button>
          <span class="ar-sp" />
          <button
            v-for="step in sullaWorking ? [] : stepsFor(item)"
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
import { computed, reactive, ref } from 'vue';

import AgentResultBody from './AgentResultBody.vue';
import { AgentResultActions } from '../../composables/useAgentResultActions';
import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import { shortenHashes } from '../../messages/sideDock';

import { PURPOSE_LABEL, findProblem, isSystemNote, reportTail } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentResultCardData, AgentResultItem, AgentResultTone } from '@pkg/shared/agentResults/AgentResultCard';

const props = defineProps<{ data: AgentResultCardData; messageId?: string }>();
const lineTime = LineTimes.useLineTime();
const when = computed(() => (props.messageId ? lineTime(props.messageId) : undefined));
/** "Finished" would contradict a Blocked or Failed chip, so it shows only for completed work. */
function kindOf(item: AgentResultItem): string {
  return item.purpose !== 'other' || item.status === 'completed' ? PURPOSE_LABEL[item.purpose] : '';
}
const actions = AgentResultActions.useAgentResultActions();
let controller: ReturnType<typeof useChatController> | undefined;
try { controller = useChatController() } catch { /* outside a chat page */ }

const ATTENTION: AgentResultTone[] = ['bad', 'warn'];

const items = computed(() => props.data.items ?? []);
const open = reactive(new Set<number>(firstOpen()));
const more = reactive(new Set<string>());
const notice = reactive<Record<string, string>>({});
const copied = ref('');

const groupSummary = computed(() => {
  const attention = items.value.filter(item => ATTENTION.includes(item.tone)).length;
  const fine = items.value.length - attention;
  return [fine && `${ fine } done`, attention && `${ attention } need${ attention === 1 ? 's' : '' } you`].filter(Boolean).join(' · ');
});

/** One agent: always open. Several: open the first that needs attention, else the first. */
function firstOpen(): number[] {
  const list = props.data.items ?? [];
  if (list.length <= 1) return [0];
  const attention = list.findIndex(item => ATTENTION.includes(item.tone));
  return [attention >= 0 ? attention : 0];
}
function isOpen(index: number): boolean { return items.value.length === 1 || open.has(index) }
function toggle(index: number): void { if (open.has(index)) open.delete(index); else open.add(index); }
function itemKey(item: AgentResultItem): string { return `${ item.jobId }:${ item.taskIndex }` }

/** The lists ("merges", "findings") shown in full for the item at `index`; kept while the item is closed. */
function expandedKinds(index: number): string[] {
  return [...more].filter(key => key.startsWith(`${ index }:`)).map(key => key.slice(`${ index }:`.length));
}
function expand(index: number, kind: string): void { more.add(`${ index }:${ kind }`) }

function byline(item: AgentResultItem): string {
  return [item.agentId, item.durationMs ? duration(item.durationMs) : ''].filter(Boolean).join(' · ');
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
/** A sentence ready to sit inside a drafted message: no trailing full stop. */
function clause(text: string | undefined): string {
  return (text ?? '').replace(/[\s.!?…]+$/, '');
}
function needsAttention(item: AgentResultItem): boolean {
  return item.status !== 'completed' || ATTENTION.includes(item.tone);
}

// ── 2 · Whose move: read from what came after this card in the chat ──
const whoNext = computed(() => {
  const messages = controller?.messages.value ?? [];
  const at = props.messageId ? messages.findIndex(message => message.id === props.messageId) : -1;
  const later = at >= 0 ? messages.slice(at + 1) : [];
  if (later.some(message => (message.kind === 'tool_question' && message.status === 'pending') || (message.kind === 'tool_approval' && message.decision === 'pending'))) {
    return 'Needs your decision: answer the question below.';
  }
  if (controller?.isRunning.value && later.every(message => message.kind !== 'sulla')) return 'Sulla is working on it now.';
  if (later.some(message => message.kind === 'sulla')) return 'Sulla replied below. If it is still open, resolve it with Sulla or mark it handled.';
  return 'Waiting on you: resolve it with Sulla, or mark it handled.';
});

/** Sulla is already on it: offering to hand it to Sulla again would only queue a duplicate. */
const sullaWorking = computed(() => whoNext.value === 'Sulla is working on it now.');

// ── 3 · Main buttons by state; each only drafts a message ──
function stepsFor(item: AgentResultItem): { label: string; prompt: string; primary: boolean }[] {
  const problem = clause(problemOf(item));
  if (item.status === 'blocked') {
    return [{ label: 'Resolve with Sulla', primary: true, prompt: `Unblock "${ item.label }"${ problem ? `: ${ problem }` : '' }. What are my options?` }];
  }
  if (item.status === 'error' || item.status === 'stopped') {
    return [
      { label: 'Ask why it failed', primary: false, prompt: `Why did "${ item.label }" fail?${ problem ? ` It reported: ${ problem }` : '' } What should we do next?` },
      { label: 'Retry', primary: true, prompt: `Relaunch "${ item.label }" with the same task${ problem ? `, and handle this first: ${ problem }` : '' }.` },
    ];
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

// ── 5 · The end of the report, where agents state where they stopped ──
function tailOf(item: AgentResultItem): string[] {
  const shownAbove = [item.outcome, problemOf(item)].filter(Boolean) as string[];
  return reportTail(item.report, item.outcome).filter(line => !shownAbove.some(text => line.includes(text.replace(/…$/, ''))));
}

// ── Details: the technical facts, each copyable where useful ──
interface Fact { label: string; value: string; copy?: string }
function factsOf(item: AgentResultItem): Fact[] {
  const facts: Fact[] = [{ label: 'Job', value: `${ item.jobId } · task ${ item.taskIndex }`, copy: item.jobId }];
  const agent = [item.agentId, item.model].filter(Boolean).join(' · ');
  if (agent) facts.push({ label: 'Agent · model', value: agent });
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
