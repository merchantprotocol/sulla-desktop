<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Interactive multiple-choice question card. Emitted by the
  `ask_user_question` tool (or its MCP twin). While pending, the user picks
  one option per question (or several when multiSelect), optionally types a
  free-form "Other", and clicks Submit. On submit the answers round-trip
  back to the blocked backend tool via ChatController.answerQuestion.
-->
<template>
  <div :class="['question', { settled: msg.status !== 'pending' }]">
    <p v-if="msg.resolutionError" role="alert">{{ msg.resolutionError }}</p>
    <div class="head">{{ msg.status === 'pending' ? 'Question' : 'Answered' }}</div>

    <div v-for="(q, qi) in msg.questions" :key="qi" class="qblock">
      <div v-if="q.header" class="chip">{{ q.header }}</div>
      <div class="qtext">{{ q.question }}</div>

      <div class="options">
        <button
          v-for="(opt, oi) in q.options"
          :key="oi"
          type="button"
          :class="['opt', { picked: isPicked(qi, opt.label) }]"
          :disabled="msg.status !== 'pending'"
          :title="opt.description || ''"
          @click="toggle(qi, opt.label, q.multiSelect === true)"
        >
          <span class="opt-label">{{ opt.label }}</span>
          <span v-if="opt.description" class="opt-desc">{{ opt.description }}</span>
        </button>
      </div>

      <input
        v-if="msg.status === 'pending'"
        v-model="otherText[qi]"
        class="other"
        type="text"
        placeholder="Or type your own answer…"
        @keyup.enter="submit"
      >
    </div>

    <div v-if="msg.status === 'pending'" class="actions">
      <button class="submit" type="button" :disabled="!canSubmit" @click="submit">Submit</button>
    </div>

    <div v-else class="answers">
      <div v-for="(a, ai) in (msg.answers || [])" :key="ai" class="answer">
        <span class="answer-q">{{ a.question }}:</span>
        <span class="answer-v">{{ a.selected.join(', ') || '—' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import type { ToolQuestionMessage, ToolQuestionAnswerItem } from '../../models/Message';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: ToolQuestionMessage }>();
const controller = useChatController();

// Per-question selected option labels and free-text. Index-aligned with
// msg.questions. reactive so the template updates on toggle.
const picks = reactive<string[][]>(props.msg.questions.map(() => []));
const otherText = reactive<string[]>(props.msg.questions.map(() => ''));

function isPicked(qi: number, label: string): boolean {
  return picks[qi]?.includes(label) ?? false;
}

function toggle(qi: number, label: string, multi: boolean): void {
  if (props.msg.status !== 'pending') return;
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
    (picks[qi]?.length ?? 0) > 0 || (otherText[qi]?.trim().length ?? 0) > 0));

function submit(): void {
  if (!canSubmit.value) return;
  const answers: ToolQuestionAnswerItem[] = props.msg.questions.map((q, qi) => {
    const selected = [...(picks[qi] ?? [])];
    const other = otherText[qi]?.trim();
    if (other) selected.push(other);
    return { question: q.question, selected };
  });
  controller.answerQuestion(props.msg.id, answers);
}
</script>

<style scoped>
.question {
  padding: 16px 20px; margin: 4px 0;
  border: 1px solid var(--accent-border, var(--accent-glow));
  border-radius: 10px;
  background: var(--accent-dim);
}
.head {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--accent-hover, var(--accent));
  margin-bottom: 12px;
  display: flex; align-items: center; gap: 10px;
}
.head::before {
  content: "?"; width: 18px; height: 18px; border-radius: 50%;
  background: var(--accent-hover, var(--accent)); color: var(--accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 900; font-size: 11px;
}
.qblock { margin-bottom: 16px; }
.qblock:last-of-type { margin-bottom: 0; }
.chip {
  display: inline-block;
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--accent-hover, var(--accent));
  border: 1px solid var(--accent-glow);
  border-radius: 4px; padding: 2px 7px; margin-bottom: 8px;
}
.qtext {
  font-family: var(--font-display); font-style: italic; font-size: 16px;
  color: var(--text-primary); line-height: 1.55; margin-bottom: 12px;
}
.options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.opt {
  display: flex; flex-direction: column; gap: 3px; text-align: left;
  padding: 9px 14px; border-radius: 7px; cursor: pointer;
  background: var(--accent-dim);
  border: 1px solid var(--accent-dim);
  transition: all 0.15s ease;
}
.opt:hover:not(:disabled) {
  border-color: var(--accent-hover, var(--accent));
  background: var(--accent-dim);
}
.opt.picked {
  border-color: var(--accent-hover, var(--accent));
  background: var(--accent-dim);
  box-shadow: 0 0 12px var(--accent-glow);
}
.opt:disabled { cursor: default; opacity: 0.55; }
.opt-label { font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); }
.opt-desc { font-family: var(--font-body); font-size: 11.5px; color: var(--text-secondary); line-height: 1.4; }
.other {
  width: 100%; box-sizing: border-box;
  padding: 8px 12px; border-radius: 6px;
  font-family: var(--font-mono); font-size: 12.5px;
  background: var(--bg-overlay);
  border: 1px solid var(--accent-dim);
  color: var(--text-primary);
}
.other:focus { outline: none; border-color: var(--accent-hover, var(--accent)); }
.actions { display: flex; gap: 10px; margin-top: 6px; }
.submit {
  padding: 8px 18px; border-radius: 6px;
  font-family: var(--font-mono); font-size: 10.5px;
  letter-spacing: 0.22em; text-transform: uppercase;
  cursor: pointer; transition: all 0.15s ease;
  background: var(--accent, var(--accent)); color: var(--text-on-accent);
  border: 1px solid var(--accent-hover, var(--accent));
}
.submit:hover:not(:disabled) { box-shadow: 0 0 18px var(--accent-glow); }
.submit:disabled { opacity: 0.4; cursor: default; }
.question.settled { opacity: 0.7; }
.answers { display: flex; flex-direction: column; gap: 4px; }
.answer { font-family: var(--font-mono); font-size: 12px; }
.answer-q { color: var(--text-secondary); }
.answer-v { color: var(--status-success, var(--accent)); margin-left: 6px; }
</style>
