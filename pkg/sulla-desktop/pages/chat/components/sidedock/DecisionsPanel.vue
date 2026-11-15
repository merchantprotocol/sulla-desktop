<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The side dock's Decisions tab: every question and approval in this chat.
  Open ones first (Answer jumps to the card, where answering happens), then
  what you chose and when. Read only.
-->
<template>
  <div class="dc">
    <p
      v-if="!decisions.length"
      class="dc-empty"
    >
      No questions or approvals in this chat yet.
    </p>
    <template v-else>
      <div class="dc-sum">
        <span
          v-for="chip in chips"
          :key="chip.key"
          class="dc-cnt"
          :class="`dc-cnt-${chip.key}`"
        ><b>{{ chip.count }}</b> {{ chip.label }}</span>
      </div>
      <article
        v-for="record in decisions"
        :key="record.id"
        class="dc-item"
        :class="{ 'dc-open': isOpenDecision(record) }"
      >
        <div class="dc-h">
          <span
            class="dc-tag"
            :class="`dc-tag-${tagOf(record).tone}`"
          >{{ tagOf(record).label }}</span>
          <span class="dc-when">{{ whenOf(record) }}</span>
          <span class="dc-sp" />
          <button
            v-if="cardFor(record)"
            type="button"
            class="dc-btn"
            :class="{ 'dc-pri': isOpenDecision(record) }"
            @click="jump(cardFor(record)!)"
          >
            {{ isOpenDecision(record) ? (record.kind === 'approval' ? 'Review' : 'Answer') : 'Jump to' }}
          </button>
        </div>
        <p class="dc-q">
          {{ record.title }}
        </p>
        <ul
          v-if="record.answers?.length"
          class="dc-a"
        >
          <li
            v-for="answer in record.answers"
            :key="answer.question"
          >
            <span v-if="record.answers.length > 1">{{ shortQuestion(answer.question, record) }}: </span><b>{{ answer.selected.join(', ') }}</b>
          </li>
        </ul>
        <p
          v-else-if="lateNote(record)"
          class="dc-note"
        >
          {{ lateNote(record) }}
        </p>
      </article>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import { isOpenDecision } from '../../messages/sideDock';

import type { DecisionRecord } from '@pkg/shared/decisions';

const props = defineProps<{ decisions: readonly DecisionRecord[] }>();
const controller = useChatController();

const chips = computed(() => {
  const count = (test: (record: DecisionRecord) => boolean) => props.decisions.filter(test).length;
  return [
    { key: 'open', label: 'open', count: count(isOpenDecision) },
    { key: 'done', label: 'answered', count: count(record => ['answered', 'approved', 'denied'].includes(record.status)) },
    { key: 'expired', label: 'expired', count: count(record => record.status === 'expired') },
  ].filter(chip => chip.count);
});

const TAG: Record<DecisionRecord['status'], { label: string; tone: string }> = {
  pending:  { label: 'Open', tone: 'open' },
  deferred: { label: 'Later', tone: 'open' },
  answered: { label: 'Answered', tone: 'ok' },
  approved: { label: 'Approved', tone: 'ok' },
  denied:   { label: 'Denied', tone: 'no' },
  expired:  { label: 'Expired', tone: 'dim' },
};
function tagOf(record: DecisionRecord) { return TAG[record.status] ?? TAG.expired }
function whenOf(record: DecisionRecord): string {
  const asked = `${ record.kind === 'approval' ? 'asked to approve' : 'asked' } ${ LineTimes.shortTime(record.createdAt) }`;
  if (!isOpenDecision(record)) return asked;
  const left = Math.round((record.expiresAt - Date.now()) / 60_000);
  return left > 0 ? `${ asked } · expires in ${ left }m` : asked;
}
function lateNote(record: DecisionRecord): string {
  return record.status === 'expired' && record.payload?.lateAnswerDelivered === 'true' ? 'Answered after it expired; sent to Sulla as a message.' : '';
}
function shortQuestion(question: string, record: DecisionRecord): string {
  const header = record.questions?.find(q => q.question === question) as { header?: string } | undefined;
  return header?.header || (question.length > 40 ? `${ question.slice(0, 39) }…` : question);
}
/** The card in the transcript for this decision, if it is in this chat. */
function cardFor(record: DecisionRecord): string | undefined {
  return controller.messages.value.find(msg =>
    (msg.kind === 'tool_question' && msg.questionId === record.id) || (msg.kind === 'tool_approval' && msg.approvalId === record.id))?.id;
}
function jump(messageId: string): void {
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}
</script>

<style scoped>
.dc {
  --dc-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --dc-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  padding: 10px 12px 12px;
}
.dc-empty { margin: 8px 2px; color: var(--dc-ink-3); font-size: 13px; }
.dc-sum { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.dc-cnt { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--dc-ink-2); font-size: 12.5px; }
.dc-cnt b { color: var(--text-primary); }
.dc-cnt-open { border-color: color-mix(in srgb, var(--status-warning) 60%, transparent); color: var(--status-warning); }
.dc-cnt-open b { color: var(--status-warning); }
.dc-item { display: grid; gap: 5px; margin-bottom: 8px; padding: 10px 12px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-page); }
.dc-open { border-color: color-mix(in srgb, var(--status-warning) 55%, transparent); background: color-mix(in srgb, var(--status-warning) 8%, var(--bg-page)); }
.dc-h { display: flex; align-items: center; gap: 8px; color: var(--dc-ink-3); font-size: 12px; }
.dc-sp { flex: 1; }
.dc-tag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 5px; font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
.dc-tag-open { background: color-mix(in srgb, var(--status-warning) 18%, transparent); color: var(--status-warning); }
.dc-tag-ok { background: color-mix(in srgb, var(--status-success) 15%, transparent); color: var(--status-success); }
.dc-tag-no { background: color-mix(in srgb, var(--status-error) 15%, transparent); color: var(--status-error); }
.dc-tag-dim { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--dc-ink-3); }
.dc-q { margin: 0; color: var(--text-primary); font-size: 13.5px; font-weight: 600; }
.dc-a { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; color: var(--dc-ink-2); font-size: 13px; }
.dc-a b { color: var(--text-primary); font-weight: 600; }
.dc-note { margin: 0; color: var(--dc-ink-2); font-size: 12.5px; }
.dc-btn { height: 26px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 7px; background: none; color: var(--dc-ink-2); font: inherit; font-size: 12px; cursor: pointer; }
.dc-btn:hover { border-color: var(--accent); color: var(--text-primary); }
.dc-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.dc-pri { border-color: var(--status-warning); background: var(--status-warning); color: var(--bg-page); font-weight: 650; }
</style>
