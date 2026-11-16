<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Find chat (⌘P): type to find a past chat, a pinned message, or one of this
  chat's decisions or results. Enter opens it; Esc closes. Reads the same
  lists the History rail and the side dock tabs use.
-->
<template>
  <div
    class="qsw"
    @mousedown.self="emit('close')"
  >
    <div
      class="qsw-box"
      role="dialog"
      aria-label="Find a chat"
    >
      <input
        ref="inputEl"
        v-model="query"
        class="qsw-input"
        placeholder="Find a chat, pin, decision or result"
        aria-label="Find a chat, pin, decision or result"
        @keydown="onKey"
      >
      <div
        class="qsw-list"
        role="listbox"
      >
        <template
          v-for="group in groups"
          :key="group.title"
        >
          <h6 class="qsw-h">
            {{ group.title }}
          </h6>
          <button
            v-for="entry in group.items"
            :key="entry.key"
            type="button"
            role="option"
            class="qsw-o"
            :aria-selected="entry.index === active"
            @mouseenter="active = entry.index"
            @click="choose(entry)"
          >
            <span class="qsw-t">{{ entry.text }}</span><small>{{ entry.meta }}</small>
          </button>
        </template>
        <p
          v-if="!flat.length"
          class="qsw-none"
        >
          Nothing matches "{{ query }}".
        </p>
      </div>
      <div class="qsw-foot">
        <span>↑↓ move</span><span>⏎ open</span><span>esc close</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { allResults, groupResults } from '../../messages/sideDock';

import type { Thread, ThreadId } from '../../models/Thread';

interface Entry { key: string; text: string; meta: string; index: number; open: () => void }

const props = defineProps<{
  threads: readonly Thread[];
  pinned:  readonly { threadId: ThreadId; threadTitle: string; messageId: any; preview: string }[];
}>();
const emit = defineEmits<{
  (e: 'activate', id: ThreadId): void;
  (e: 'jump-to', target: { threadId: ThreadId; messageId: any }): void;
  (e: 'close'): void;
}>();

const controller = useChatController();
const { decisions } = ChatDecisions.useChatDecisions();
const query = ref('');
const active = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

const matches = (text: string) => !query.value.trim() || text.toLowerCase().includes(query.value.trim().toLowerCase());
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const groups = computed(() => {
  let index = 0;
  const here = controller.thread.value.id;
  const jump = (messageId: string) => () => emit('jump-to', { threadId: here, messageId });
  const make = (title: string, items: Omit<Entry, 'index'>[]) => ({ title, items: items.slice(0, 6).map(item => ({ ...item, index: index++ })) });
  const chats = props.threads.filter(thread => matches(thread.title))
    .map(thread => ({ key: `t:${ thread.id }`, text: thread.title, meta: thread.id === here ? 'this chat' : day(thread.updatedAt), open: () => emit('activate', thread.id) }));
  const pins = props.pinned.filter(pin => matches(pin.preview) || matches(pin.threadTitle))
    .map(pin => ({ key: `p:${ pin.messageId }`, text: pin.preview, meta: pin.threadTitle, open: () => emit('jump-to', { threadId: pin.threadId, messageId: pin.messageId }) }));
  const cards = (record: { id: string }) => controller.messages.value.find(msg =>
    (msg.kind === 'tool_question' && msg.questionId === record.id) || (msg.kind === 'tool_approval' && msg.approvalId === record.id))?.id;
  const here_ = [
    ...decisions.value.filter(record => matches(record.title) && cards(record))
      .map(record => ({ key: `d:${ record.id }`, text: `Decision · ${ record.title }`, meta: record.status, open: jump(cards(record)!) })),
    ...allResults(groupResults(controller.messages.value))
      .filter(entry => matches(entry.item.label) || matches(entry.item.outcome))
      .map(entry => ({ key: `r:${ entry.item.jobId }:${ entry.item.taskIndex }`, text: `Result · ${ entry.item.label }`, meta: entry.item.verdict, open: jump(entry.messageId) })),
  ];
  return [make('Chats', chats), make('Pinned', pins), make('In this chat', here_)].filter(group => group.items.length);
});
const flat = computed(() => groups.value.flatMap(group => group.items));
watch(query, () => { active.value = 0 });

function choose(entry: Entry): void { entry.open() }
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); active.value = Math.min(flat.value.length - 1, active.value + 1); return }
  if (event.key === 'ArrowUp') { event.preventDefault(); active.value = Math.max(0, active.value - 1); return }
  if (event.key === 'Enter') { event.preventDefault(); const entry = flat.value[active.value]; if (entry) choose(entry); }
}
onMounted(() => nextTick(() => inputEl.value?.focus()));
</script>

<style scoped>
.qsw { position: fixed; inset: 0; z-index: 80; display: grid; place-items: start center; padding-top: 14vh; background: color-mix(in srgb, var(--bg-page) 60%, transparent); }
.qsw-box { width: min(620px, 92vw); overflow: hidden; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--bg-surface); box-shadow: var(--elev-float, 0 30px 70px -20px rgba(0, 0, 0, .7)); font-family: var(--font-body); }
.qsw-input { width: 100%; height: 52px; padding: 0 18px; border: 0; border-bottom: 1px solid var(--border-default); background: none; color: var(--text-primary); font: inherit; font-size: 16px; outline: none; }
.qsw-list { max-height: 52vh; overflow: auto; padding-bottom: 6px; }
.qsw-h { margin: 10px 18px 4px; color: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface)); font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.qsw-o { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 18px; border: 0; background: none; color: color-mix(in srgb, var(--text-primary) 82%, var(--bg-surface)); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.qsw-o[aria-selected="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text-primary); }
.qsw-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qsw-o small { margin-left: auto; flex: none; color: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface)); font-size: 12px; }
.qsw-none { margin: 14px 18px; color: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface)); font-size: 13px; }
.qsw-foot { display: flex; gap: 14px; padding: 9px 18px; border-top: 1px solid var(--border-default); color: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface)); font: 11.5px var(--font-mono, ui-monospace, monospace); }
</style>
