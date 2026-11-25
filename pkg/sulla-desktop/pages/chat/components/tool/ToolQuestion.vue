<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Choices reuse the inline answer route or the persistent For You callback. -->
<template>
  <section
    class="qc"
    :class="{ 'qc-settled': locked, 'qc-original': retainOptions, 'qc-route': routePresentation }"
    :aria-disabled="locked"
    :aria-label="routePresentation ? `Question from ${routePresentation.requesterLabel}` : 'Question from Sulla'"
  >
    <template v-if="routePresentation">
      <DecisionHolderLine :presentation="routePresentation" /><p class="qc-route-from"><span class="qc-route-avatar">{{ routePresentation.requesterInitial }}</span><span>Question from <b>{{ routePresentation.requesterLabel }}</b></span></p><DecisionTrail :rows="routePresentation.trail" />
    </template>
    <header v-else class="qc-status">
      <span
        class="qc-state"
        :class="stateTone"
      >
        <span
          class="qc-state-dot"
          aria-hidden="true"
        />{{ stateText }}
      </span>
      <span
        v-if="remaining !== null"
        class="qc-countdown"
        :class="{ urgent: remaining < 60_000 }"
      >Expires in {{ countdown }}</span>
    </header>

    <div :class="{ 'qc-route-body': routePresentation }">
    <p
      v-if="msg.resolutionError"
      class="qc-error"
      role="alert"
    >
      {{ msg.resolutionError }}
    </p>
    <p
      v-if="expiredUnsent"
      class="qc-note"
    >
      This question expired before an answer was sent, so Sulla moved on without it.
      <button
        v-if="hasDraft"
        type="button"
        class="qc-late"
        @click="sendAsMessage"
      >
        Send my answers as a message
      </button>
    </p>
    <p
      v-if="msg.resolutionNote"
      class="qc-note"
    >
      {{ msg.resolutionNote }}
    </p>

    <fieldset
      v-for="(q, qi) in msg.questions"
      v-show="!persistent || currentStep === qi"
      :key="qi"
      :ref="el => { blocks[qi] = el as HTMLElement | null }"
      class="qc-block"
      :class="{ 'qc-open': !locked && missing.length < msg.questions.length && missing.some(m => m.qi === qi) }"
      :disabled="locked"
    >
      <legend class="qc-question">
        <span
          v-if="q.header"
          class="qc-topic"
        >{{ q.header }}</span>
        {{ q.question }}
      </legend>
      <pre v-if="submitAnswers && !persistent && q.command">{{ q.command }}</pre>
      <p
        v-if="!locked"
        class="qc-hint"
      >
        {{ q.multiSelect ? 'Choose any that apply' : 'Choose one' }}
      </p>

      <div
        v-if="retainOptions || !locked || picks[qi]?.length"
        class="qc-options"
        :role="q.multiSelect ? 'group' : 'radiogroup'"
      >
        <button
          v-for="(opt, oi) in q.options"
          :key="oi"
          type="button"
          class="qc-option"
          :class="{ picked: isPicked(qi, opt.label), multi: q.multiSelect }"
          :role="q.multiSelect ? 'checkbox' : 'radio'"
          :aria-checked="isPicked(qi, opt.label)"
          @click="toggle(qi, opt.label, q.multiSelect === true)"
        >
          <span
            class="qc-mark"
            aria-hidden="true"
          ><svg
            v-if="q.multiSelect"
            viewBox="0 0 16 16"
          ><path d="M3.5 8.5l3 3 6-7" /></svg></span>
          <span class="qc-option-text">
            <span class="qc-label">{{ opt.label }}</span>
            <span
              v-if="opt.description"
              class="qc-desc"
            >{{ opt.description }}</span>
          </span>
        </button>
        <div
          v-if="!locked"
          class="qc-option qc-custom"
          :class="{ picked: customSelected[qi], multi: q.multiSelect }"
          @click.self="selectCustom(qi, true)"
        >
          <input
            class="qc-mark qc-custom-choice"
            :type="q.multiSelect ? 'checkbox' : 'radio'"
            :name="`custom-${msg.id}-${qi}`"
            :checked="customSelected[qi]"
            :aria-label="`Write your own answer to: ${q.question}`"
            @change="selectCustom(qi, ($event.target as HTMLInputElement).checked)"
          >
          <input
            v-model="otherText[qi]"
            class="qc-other"
            type="text"
            placeholder="Or write your own answer"
            :aria-label="`Your own answer to: ${q.question}`"
            @focus="selectCustom(qi, true)"
            @input="selectCustom(qi, true)"
            @keyup.enter="submit"
          >
        </div>
      </div>
    </fieldset>

    <div
      v-if="persistent && msg.questions.length > 1"
      class="qc-actions"
    >
      <button
        v-if="currentStep > 0"
        type="button"
        class="qc-jump"
        @click="currentStep--"
      >
        Back
      </button>
      <span class="qc-hint">{{ currentStep + 1 }} of {{ msg.questions.length }} questions</span>
      <button
        v-if="currentStep < msg.questions.length - 1"
        type="button"
        class="qc-submit"
        @click="currentStep++"
      >
        Next question
      </button>
    </div>
    <footer
      v-if="!locked && (!persistent || currentStep === msg.questions.length - 1)"
      class="qc-actions"
    >
      <button
        class="qc-submit"
        type="button"
        :disabled="!canSubmit"
        @click="submit"
      >
        Submit answer
      </button>
      <span
        v-if="!canSubmit && missing.length && missing.length < msg.questions.length"
        class="qc-hint"
      >Answer {{ missing.length }} more {{ missing.length === 1 ? 'question' : 'questions' }} first: <button
        v-for="(m, mi) in missing"
        :key="m.qi"
        type="button"
        class="qc-jump"
        @click="jumpTo(m.qi)"
      >{{ m.name }}{{ mi < missing.length - 1 ? ',' : '' }}</button></span>
      <span
        v-else-if="!canSubmit"
        class="qc-hint"
      >Pick an option or write an answer{{ msg.questions.length > 1 ? ' for each question' : '' }} to continue.</span>
      <span v-if="routePresentation?.turn === 'with-agent'" class="qc-hint qc-route-hint">You can answer now. Your answer goes straight to {{ routePresentation.requesterLabel }} and {{ routePresentation.holderLabel }} stops.</span>
    </footer>

    <dl
      v-else-if="msg.answers?.length && !picksShown"
      class="qc-answers"
    >
      <template
        v-for="(a, ai) in msg.answers"
        :key="ai"
      >
        <dt>{{ a.question }}</dt>
        <dd>{{ a.selected.join(', ') || 'No selection' }}</dd>
      </template>
    </dl>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { DecisionRecord } from '@pkg/shared/decisions';
import type { ToolQuestionMessage, ToolQuestionAnswerItem } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';
import { answerSelection } from '../../messages/questionAnswer';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { DecisionRoutePresenter } from '../../decisions/DecisionRoutePresenter';
import DecisionHolderLine from './DecisionHolderLine.vue';
import DecisionTrail from './DecisionTrail.vue';

const props = defineProps<{ msg: ToolQuestionMessage; decision?: DecisionRecord; persistent?: boolean; blocked?: boolean; retainOptions?: boolean; stateLabel?: string; draft?: { picks: string[][]; other: string[]; customSelected?: boolean[] }; submitAnswers?: (answers: ToolQuestionAnswerItem[]) => Promise<void> }>();
const controller = useChatController();
const decisionStore = ChatDecisions.useChatDecisions();
const routePresenter = new DecisionRoutePresenter({ now: () => decisionStore.now.value });
const routePresentation = computed(() => { const record = props.decision ?? (props.msg.questionId ? decisionStore.inlineRecord(props.msg.questionId, 'question') : undefined); return record?.route ? routePresenter.present(record) : undefined });
const currentStep = ref(0);

// Per-question selected option labels and free-text. Index-aligned with
// msg.questions. reactive so the template updates on toggle.
const picks = reactive<string[][]>(props.draft?.picks ?? props.msg.questions.map(() => []));
const otherText = reactive<string[]>(props.draft?.other ?? props.msg.questions.map(() => ''));
const customSelected = reactive<boolean[]>(props.draft?.customSelected ?? props.msg.questions.map((q, qi) => !!otherText[qi]?.trim() && (!!q.multiSelect || !picks[qi]?.length)));
function selectCustom(qi: number, selected: boolean): void {
  if (locked.value) return;
  customSelected[qi] = selected;
  if (selected && !props.msg.questions[qi].multiSelect) picks[qi] = [];
}
function customAnswer(qi: number): string { return customSelected[qi] ? (otherText[qi] ?? '') : '' }
function selectedLabels(qi: number): readonly string[] {
  if (props.retainOptions && props.msg.status !== 'pending') {
    const question = props.msg.questions[qi].question;
    return props.msg.answers?.find(answer => answer.question === question)?.selected ?? [];
  }
  return picks[qi] ?? [];
}
function isPicked(qi: number, label: string): boolean { return selectedLabels(qi).includes(label) }
// Countdown to the backend's deadline; the card used to give no sign it would expire.
const now = ref(Date.now());
const ticker = setInterval(() => { now.value = Date.now() }, 1_000);
onBeforeUnmount(() => clearInterval(ticker));
const remaining = computed(() => !props.persistent && !props.submitAnswers && props.msg.status === 'pending' && !sending.value && props.msg.expiresAt ? Math.max(0, props.msg.expiresAt - now.value) : null);
const countdown = computed(() => {
  const seconds = Math.ceil((remaining.value ?? 0) / 1_000);
  return `${ Math.floor(seconds / 60) }:${ String(seconds % 60).padStart(2, '0') }`;
});
const stateText = computed(() => {
  if (props.stateLabel) return props.stateLabel;
  if (props.msg.status === 'answered') return 'Answered';
  if (props.msg.status === 'timed_out') return 'Expired';
  if (props.msg.resolutionError) return 'Not sent';
  return sending.value ? (props.submitAnswers ? 'Saving answer…' : 'Answer sent') : 'Waiting for your answer';
});
const stateTone = computed(() => props.msg.status === 'answered' || sending.value ? 'done' : props.msg.status === 'timed_out' ? 'closed' : 'open');
const expiredUnsent = computed(() => !props.submitAnswers && props.msg.status === 'timed_out' && !(props.msg.answers?.length));
const hasDraft = computed(() => picks.some(p => p.length > 0) || otherText.some(t => t.trim()));
/** The answered card already shows each question with the option picked; the summary list is only for when those picks are not known (e.g. after a restart). */
const picksShown = computed(() => !!props.msg.answers?.length && props.msg.answers.every((answer, qi) =>
  answer.selected.length > 0 && answer.selected.every(choice => props.retainOptions
    ? props.msg.questions.find(question => question.question === answer.question)?.options.some(option => option.label === choice)
    : picks[qi]?.includes(choice))));

/** The deadline passed while the user was still choosing: keep their work by sending it as a chat message. */
function sendAsMessage(): void {
  const lines = props.msg.questions.map((q, qi) => {
    const selected = answerSelection(picks[qi] ?? [], customAnswer(qi), !!q.multiSelect);
    return selected.length ? `- ${ q.question }\n  ${ selected.join(', ') }` : '';
  }).filter(Boolean);
  if (lines.length) controller.send(`My answers to your expired question:\n${ lines.join('\n') }`);
}
// Locks the card the moment Submit is pressed, before the backend confirms,
// so the answered card can't read as a second open prompt or be re-submitted.
const sending = ref(false);
const locked = computed(() => !!props.blocked || sending.value || props.msg.status !== 'pending');
// The backend rejected the answer: reopen the card so it can be fixed and resent.
watch(() => props.msg.resolutionError, (error) => {
  if (error && props.msg.status !== 'answered' && props.msg.status !== 'timed_out') sending.value = false;
});
function toggle(qi: number, label: string, multi: boolean): void {
  if (locked.value) return;
  if (!multi) customSelected[qi] = false;
  const cur = picks[qi] ?? [];
  if (cur.includes(label)) {
    picks[qi] = cur.filter(l => l !== label);
  } else {
    picks[qi] = multi ? [...cur, label] : [label];
  }
}

// Every question must have at least one selection or a non-empty "Other".
const canSubmit = computed(() =>
  props.msg.questions.every((_q, qi) =>
    (picks[qi]?.length ?? 0) > 0 || customAnswer(qi).trim().length > 0));
/** Questions still without an answer, named by their short header when they have one. */
const missing = computed(() => props.msg.questions
  .map((q, qi) => ({ qi, name: q.header || `Question ${ qi + 1 }`, done: (picks[qi]?.length ?? 0) > 0 || customAnswer(qi).trim().length > 0 }))
  .filter(x => !x.done));
const blocks = reactive<(HTMLElement | null)[]>([]);
function jumpTo(qi: number): void {
  currentStep.value = qi;
  const el = blocks[qi];
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el?.querySelector<HTMLElement>('.qc-option')?.focus({ preventScroll: true });
}
async function submit(): Promise<void> {
  if (locked.value || !canSubmit.value) return;
  const answers: ToolQuestionAnswerItem[] = props.msg.questions.map((q, qi) => {
    return { question: q.question, selected: answerSelection(picks[qi] ?? [], customAnswer(qi), !!q.multiSelect) };
  });
  sending.value = true;
  if (props.submitAnswers) {
    try { await props.submitAnswers(answers) } catch { /* The inbox displays the error and preserves the draft. */ } finally { sending.value = false }
  } else controller.answerQuestion(props.msg.id, answers);
}
</script>

<style scoped>
/* One sans family throughout: the question reads like body text, options like
   standard radio/checkbox rows. Only theme tokens every theme defines. */
.qc {
  margin: 4px 0;
  padding: 16px 18px 18px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-body);
  transition: opacity 0.2s ease;
}
.qc-route { max-width: 640px; min-width: 0; padding: 12px 16px 14px; border-color: var(--border-strong); border-radius: 12px; background: var(--bg-surface); } .qc-route.qc-settled { opacity: 1; border-color: var(--border-default); background: var(--bg-surface); }
.qc-route-from { display: flex; align-items: flex-start; gap: 7px; margin: 8px 0 0; color: var(--text-secondary); font-size: 12.5px; line-height: 20px; } .qc-route-from b { color: var(--text-primary); font: 500 11.5px var(--font-mono); } .qc-route-avatar { display: grid; place-items: center; width: 18px; height: 18px; flex: none; margin-top: 1px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface)); color: var(--accent); font-size: 10px; font-weight: 700; }
.qc-route-body { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-default); } .qc-route-body .qc-block { margin: 0; padding: 0; border: 0; border-radius: 0; } .qc-route-body .qc-block + .qc-block { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-default); } .qc-route-body .qc-block + .qc-block::before { display: none; }
.qc-route-body .qc-question { float: none; font-size: 15px; line-height: 1.55; } .qc-route-body .qc-options { margin: 10px 0 0; } .qc-route-body .qc-option { padding: 10px 14px; background: var(--bg-surface); } .qc-route-body .qc-actions { flex-wrap: wrap; gap: 8px 12px; margin-top: 12px; } .qc-route-body .qc-submit { height: 30px; padding: 0 14px; border-radius: 8px; font-size: 13px; font-weight: 500; } .qc-route-hint { flex: 1 1 220px; min-width: 0; color: var(--text-muted); line-height: 18px; }
.qc-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; font-size: 12.5px; }
.qc-state { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; color: var(--text-secondary); }
.qc-state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.qc-state.done .qc-state-dot { background: var(--status-success); }
.qc-state.closed .qc-state-dot { background: var(--text-muted); }
.qc-countdown { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.qc-countdown.urgent { color: var(--status-warning); font-weight: 600; }
/*
 * Each question sits in a padded box (pulled out by the same amount, so text
 * stays aligned with the card) with a transparent border, so the "needs an
 * answer" state only recolours it and never shifts layout. The legend floats
 * so the fieldset box starts above the question, not through its middle.
 */
.qc-block { position: relative; margin: 0 -14px; padding: 12px 14px 14px; border: 1px solid transparent; border-radius: 10px; min-width: 0; }
.qc-block + .qc-block { margin-top: 12px; }
.qc-block + .qc-block::before {
  content: ''; position: absolute; top: -7px; left: 14px; right: 14px; height: 1px;
  background: var(--border-subtle, var(--border-default));
}
.qc-question { float: left; width: 100%; padding: 0; max-width: 70ch; font-size: 15px; line-height: 1.6; font-weight: 400; color: var(--text-primary); }
.qc-question + * { clear: both; }
.qc-topic { display: block; margin-bottom: 4px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.qc-hint { margin: 6px 0 0; font-size: 12.5px; color: var(--text-muted); }
.qc-options { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 10px; }
.qc-option {
  display: flex; align-items: flex-start; gap: 12px; width: 100%;
  padding: 11px 14px; text-align: left; cursor: pointer;
  border: 1px solid var(--border-default); border-radius: 10px;
  background: var(--bg-page, var(--bg-surface)); color: var(--text-primary);
  font: inherit;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.qc-option:hover { border-color: color-mix(in srgb, var(--accent) 60%, var(--border-default)); }
.qc-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.qc-option.picked { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface)); }
.qc-mark {
  display: grid; place-items: center; flex: none; width: 18px; height: 18px; margin-top: 1px;
  border: 1.5px solid var(--text-muted); border-radius: 50%;
}
.qc-option.multi .qc-mark { border-radius: 5px; }
.qc-option.picked .qc-mark { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--bg-surface); }
.qc-option.multi.picked .qc-mark { box-shadow: none; }
.qc-mark svg { width: 12px; height: 12px; fill: none; stroke: var(--text-on-accent, #fff); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
.qc-option.multi.picked .qc-mark svg { opacity: 1; }
.qc-option-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.qc-label { font-size: 14px; font-weight: 600; line-height: 1.4; }
.qc-desc { font-size: 13px; line-height: 1.45; color: var(--text-secondary); }
.qc-custom { align-items: center; }
.qc-custom-choice { appearance: none; cursor: pointer; padding: 0; }
.qc-custom-choice:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.qc-custom-choice:checked { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--bg-surface); }
.qc-custom-choice[type=checkbox] { appearance: auto; accent-color: var(--accent); }
.qc-other {
  min-width: 0; flex: 1; width: 100%; box-sizing: border-box; height: 38px; padding: 0 12px;
  border: 1px solid var(--border-default); border-radius: 8px;
  background: var(--bg-page, var(--bg-surface)); color: var(--text-primary);
  font: 14px var(--font-body);
}
.qc-other::placeholder { color: var(--text-muted); }
.qc-other:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.qc-actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.qc-actions .qc-hint { margin: 0; }
.qc-jump { border: 0; background: none; padding: 0 0 0 4px; color: var(--primary-color-text-override, var(--accent)); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.qc-block.qc-open { border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: color-mix(in srgb, var(--accent) 5%, transparent); }
.qc-submit {
  height: 36px; padding: 0 16px; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--accent); color: var(--text-on-accent, #fff);
  font: 600 13.5px var(--font-body);
}
.qc-submit:hover { filter: brightness(1.08); }
.qc-submit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.qc-submit:disabled { cursor: default; filter: none; opacity: 0.45; }
.qc-error { margin: 0 0 12px; font-size: 13px; color: var(--status-error); }
.qc-note { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.qc-late {
  display: block; margin-top: 8px; padding: 6px 12px; cursor: pointer; pointer-events: auto;
  border: 1px solid var(--accent); border-radius: 8px; background: transparent;
  color: var(--text-primary); font: 600 13px var(--font-body);
}
.qc-answers { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px 0; margin: 14px 0 0; font-size: 13px; }
.qc-answers dt { color: var(--text-secondary); }
.qc-answers dd { margin: 0 0 8px; font-weight: 600; color: var(--text-primary); }
/* Answered or expired: quieter and inert, so it never reads as a second open prompt. */
.qc-settled { opacity: 0.62; background: transparent; }
.qc-settled .qc-option { cursor: default; }
/* Only the chosen options stay once answered (picks exist only in the session that answered). */
.qc-settled:not(.qc-original) .qc-option:not(.picked) { display: none; }
.qc-settled .qc-option:hover { border-color: var(--border-default); }
.qc-settled:has(.qc-late) { opacity: 0.9; }
@media (prefers-reduced-motion: reduce) {
  .qc, .qc-option { transition: none; }
}
</style>
