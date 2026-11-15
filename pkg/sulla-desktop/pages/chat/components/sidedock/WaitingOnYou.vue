<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Everything in this chat that waits on the user, first in the Sulla tab:
  tasks (Done, Copy command), questions (Answer) and approvals (Review),
  each able to jump to its card in the transcript.
-->
<template>
  <section
    class="wy"
    aria-label="Waiting on you"
  >
    <h3 class="wy-sec">
      Waiting on you <span class="wy-n">{{ items.length }}</span>
    </h3>
    <ul class="wy-list">
      <li
        v-for="msg in items"
        :key="msg.id"
        class="wy-i"
      >
        <div class="wy-k">
          {{ kindOf(msg) }}<span class="wy-age">{{ ageOf(msg.createdAt) }}</span>
        </div>
        <div class="wy-t">
          {{ titleOf(msg) }}
        </div>
        <div
          v-if="detailOf(msg)"
          class="wy-m"
          :title="detailOf(msg)"
        >
          {{ detailOf(msg) }}
        </div>
        <div class="wy-a">
          <template v-if="TaskAsks.isTask(msg)">
            <button
              type="button"
              class="wy-b wy-pri"
              @click="TaskAsks.done(controller, msg)"
            >
              Done
            </button>
            <button
              v-if="TaskAsks.item(msg).command"
              type="button"
              class="wy-b"
              @click="copy(msg)"
            >
              {{ copied === msg.id ? 'Copied' : 'Copy command' }}
            </button>
          </template>
          <button
            v-else
            type="button"
            class="wy-b wy-pri"
            @click="jump(msg.id)"
          >
            {{ msg.kind === 'tool_approval' ? 'Review' : 'Answer' }}
          </button>
          <button
            type="button"
            class="wy-b"
            @click="jump(msg.id)"
          >
            Jump to
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { TaskAsks } from '../../messages/taskAsk';
import { activityAge } from '../../messages/threadActivity';

import type { ToolApprovalMessage, ToolQuestionMessage } from '../../models/Message';

type Waiting = ToolQuestionMessage | ToolApprovalMessage;

const props = defineProps<{ items: readonly Waiting[]; now: number }>();
const controller = useChatController();

function kindOf(msg: Waiting): string {
  if (msg.kind === 'tool_approval') return 'Approval';
  return TaskAsks.isTask(msg) ? 'Task' : 'Question';
}
function titleOf(msg: Waiting): string {
  if (msg.kind === 'tool_approval') return msg.reason || 'Approve a command';
  if (TaskAsks.isTask(msg)) return TaskAsks.title(msg);
  const first = msg.questions[0];
  return msg.questions.length > 1 ? `${ msg.questions.length } questions` : (first?.header || first?.question || 'A question');
}
function detailOf(msg: Waiting): string {
  if (msg.kind === 'tool_approval') return msg.command;
  const first = msg.questions[0];
  return first && titleOf(msg) !== first.question ? first.question : '';
}
function ageOf(at: number): string { return Number.isFinite(at) ? activityAge(Math.max(0, props.now - at)) : '' }
function jump(messageId: string): void {
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}
const copied = ref('');
async function copy(msg: ToolQuestionMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText(TaskAsks.item(msg).command ?? '');
    copied.value = msg.id;
    setTimeout(() => { if (copied.value === msg.id) copied.value = ''; }, 1500);
  } catch { /* clipboard blocked: Jump to shows the command */ }
}
</script>

<style scoped>
/* Component-prefixed classes: themes restyle generic names. */
.wy { --wy-you: var(--status-warning); --wy-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface)); --wy-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface)); margin: 0 0 14px; }
.wy-sec { display: flex; align-items: center; gap: 6px; margin: 0 2px 6px; color: var(--wy-you); font: 700 11px var(--font-body); letter-spacing: .1em; text-transform: uppercase; }
.wy-n { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--wy-you); color: var(--bg-page); font: 700 10px/1 var(--font-body); letter-spacing: 0; }
.wy-list { margin: 0; padding: 0; list-style: none; overflow: hidden; border: 1px solid color-mix(in srgb, var(--wy-you) 45%, var(--border-default)); border-radius: 12px; background: color-mix(in srgb, var(--wy-you) 6%, var(--bg-page)); }
.wy-i { display: grid; gap: 4px; padding: 10px 12px; }
.wy-i + .wy-i { border-top: 1px solid color-mix(in srgb, var(--wy-you) 20%, var(--border-default)); }
.wy-k { display: flex; align-items: center; color: var(--wy-you); font: 600 10.5px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
.wy-age { margin-left: auto; color: var(--wy-ink-3); font-weight: 500; letter-spacing: 0; text-transform: none; }
.wy-t { color: var(--text-primary); font-size: 13.5px; font-weight: 650; }
.wy-m { display: -webkit-box; overflow: hidden; color: var(--wy-ink-2); font-size: 12.5px; line-height: 1.45; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.wy-a { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.wy-b { height: 28px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: 8px; background: none; color: var(--wy-ink-2); font: 600 12px var(--font-body); cursor: pointer; }
.wy-b:hover { color: var(--text-primary); border-color: var(--accent); }
.wy-pri { border: 0; background: var(--wy-you); color: var(--bg-page); }
.wy-pri:hover { color: var(--bg-page); filter: brightness(1.08); }
.wy-b:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
