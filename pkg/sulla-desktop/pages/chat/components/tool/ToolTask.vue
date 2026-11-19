<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Something Sulla needs the user to do (ask_user_question with task: true):
  a card that says what, shows the command with Copy, and takes Done or a
  reply. Done stays as a small record afterwards.
-->
<template>
  <section
    class="tk"
    :class="{ 'tk-done': answered }"
    :aria-label="`Task for you: ${title}`"
  >
    <header class="tk-h">
      <span
        class="tk-dot"
        aria-hidden="true"
      />
      <span>{{ stateText }}</span>
      <span class="tk-at">asked {{ askedAt }}</span>
    </header>
    <div class="tk-b">
      <h3 class="tk-t">
        {{ title }}
      </h3>
      <template v-if="!answered">
        <p
          v-if="item.question !== title"
          class="tk-q"
        >
          {{ item.question }}
        </p>
        <div
          v-if="item.command"
          class="tk-cmd"
        >
          <code>{{ item.command }}</code>
          <button
            type="button"
            class="tk-copy"
            @click="copy"
          >
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </div>
        <p
          v-if="msg.status === 'timed_out'"
          class="tk-note"
        >
          Sulla stopped waiting; Done still tells it in the chat.
        </p>
      </template>
      <p
        v-else-if="reply"
        class="tk-q"
      >
        {{ reply }}
      </p>
    </div>
    <footer
      v-if="!answered"
      class="tk-f"
    >
      <button
        type="button"
        class="tk-btn tk-pri"
        :disabled="sending"
        @click="done"
      >
        Done
      </button>
      <template v-if="replying">
        <input
          v-model="text"
          class="tk-in"
          type="text"
          placeholder="Tell Sulla what happened"
          aria-label="Reply to this task"
          @keyup.enter="sendReply"
        >
        <button
          type="button"
          class="tk-btn"
          :disabled="sending || !text.trim()"
          @click="sendReply"
        >
          Send
        </button>
      </template>
      <button
        v-else
        type="button"
        class="tk-btn"
        @click="replying = true"
      >
        Reply…
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { TaskAsks } from '../../messages/taskAsk';

import type { ToolQuestionMessage } from '../../models/Message';

const props = defineProps<{ msg: ToolQuestionMessage; submitAnswer?: (value: string) => Promise<void>; draft?: { other: string[] } }>();
const sending = ref(false);
const controller = useChatController();

const item = computed(() => TaskAsks.item(props.msg));
const title = computed(() => TaskAsks.title(props.msg));
const said = computed(() => props.msg.answers?.[0]?.selected?.[0]);
const answered = computed(() => props.msg.status === 'answered' || !!said.value);
const reply = computed(() => (said.value && said.value !== 'Done' ? said.value : ''));
const stateText = computed(() => {
  if (answered.value) return said.value === 'Done' || !said.value ? 'Done' : 'Replied';
  return props.msg.status === 'timed_out' ? 'Still waiting on you' : 'Waiting on you';
});
const askedAt = computed(() => new Date(props.msg.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));

const replying = ref(!!props.draft?.other[0]);
const localText = ref('');
// The parent-owned draft intentionally persists across tab remounts.
// eslint-disable-next-line vue/no-mutating-props
const text = computed({ get: () => props.draft?.other[0] ?? localText.value, set: value => { if (props.draft) props.draft.other[0] = value; else localText.value = value; } });
async function done(): Promise<void> {
  if (!props.submitAnswer) { TaskAsks.done(controller, props.msg); return }
  if (sending.value) return; sending.value = true;
  try { await props.submitAnswer('Done') } catch { /* The inbox displays the error and preserves the draft. */ } finally { sending.value = false }
}
async function sendReply(): Promise<void> {
  if (!text.value.trim() || sending.value) return;
  if (props.submitAnswer) {
    sending.value = true;
    try { await props.submitAnswer(text.value) } catch { return } finally { sending.value = false }
  } else TaskAsks.reply(controller, props.msg, text.value);
  text.value = '';
  replying.value = false;
}

const copied = ref(false);
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(item.value.command ?? '');
    copied.value = true;
    setTimeout(() => { copied.value = false }, 1500);
  } catch { /* clipboard blocked: the command is still selectable */ }
}
</script>

<style scoped>
/* Component-prefixed classes: themes restyle generic names. */
.tk {
  --tk-you: var(--status-warning);
  --tk-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --tk-ink-3: color-mix(in srgb, var(--text-primary) 55%, var(--bg-surface));
  margin: 14px 0 6px; overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--tk-you) 55%, var(--border-default)); border-radius: 14px;
  background: color-mix(in srgb, var(--tk-you) 7%, var(--bg-surface)); color: var(--text-primary);
  font-family: var(--font-body);
}
.tk-h { display: flex; align-items: center; gap: 8px; padding: 12px 16px 0; color: var(--tk-you); font: 600 11.5px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
.tk-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 22%, transparent); }
.tk-at { margin-left: auto; color: var(--tk-ink-3); font-weight: 500; letter-spacing: 0; text-transform: none; }
.tk-b { padding: 8px 16px 14px; }
.tk-t { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
.tk-q { margin: 0 0 10px; color: var(--tk-ink-2); font-size: 14px; line-height: 1.55; }
.tk-cmd { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px 9px 12px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-page); }
.tk-cmd code { flex: 1; min-width: 0; color: var(--tk-ink-2); font: 12.5px/1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.tk-copy { flex: none; height: 26px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 7px; background: none; color: var(--tk-ink-2); font: 500 12px var(--font-body); cursor: pointer; }
.tk-copy:hover { color: var(--text-primary); border-color: var(--accent); }
.tk-note { margin: 10px 0 0; color: var(--tk-ink-3); font-size: 12.5px; }
.tk-f { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid color-mix(in srgb, var(--tk-you) 25%, var(--border-default)); background: color-mix(in srgb, var(--tk-you) 4%, var(--bg-page)); }
.tk-btn { height: 32px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 9px; background: none; color: var(--text-primary); font: 600 13px var(--font-body); cursor: pointer; }
.tk-btn:disabled { opacity: .5; cursor: default; }
.tk-pri { border: 0; background: var(--tk-you); color: var(--bg-page); }
.tk-btn:focus-visible, .tk-copy:focus-visible, .tk-in:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tk-in { flex: 1 1 200px; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--bg-page); color: var(--text-primary); font: 13.5px var(--font-body); }
/* Done: a small record that stays in place. */
.tk-done { border-color: var(--border-default); background: var(--bg-surface); }
.tk-done .tk-h { color: var(--status-success); }
.tk-done .tk-dot { box-shadow: none; }
.tk-done .tk-b { padding-bottom: 12px; }
.tk-done .tk-t { margin: 0; }
</style>
