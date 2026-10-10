<!--
  AgentConversations — stored conversations for one agent, opened by clicking
  an agent row in AgentsTab.

  Left: that agent channel's conversation_history rows (newest first, paged).
  Right: the selected conversation's message log — user prompts, assistant
  replies, tool calls, and start/finish markers. Both refresh on the parent's
  poll tick so a running conversation streams in.
-->
<template>
  <div class="conv-root flex flex-col h-full">
    <div class="conv-toolbar flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        class="conv-back"
        @click="$emit('close')"
      >
        {{ conversationId ? '← Close' : '← All agents' }}
      </button>
      <div class="min-w-0">
        <p class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
          {{ agentName }}
        </p>
        <p class="text-xs text-slate-500 font-mono truncate">
          {{ channel }}
        </p>
      </div>
    </div>

    <div class="flex flex-1 min-h-0">
      <!-- Conversation list -->
      <aside v-if="!conversationId" class="conv-list flex-shrink-0 overflow-auto">
        <p
          v-if="listLoading && !conversations.length"
          class="px-4 py-6 text-xs text-slate-500"
        >
          Loading conversations…
        </p>
        <p
          v-else-if="!conversations.length"
          class="px-4 py-6 text-xs text-slate-500"
        >
          No stored conversations for this agent.
        </p>
        <button
          v-for="conv in conversations"
          :key="conv.id"
          type="button"
          class="conv-item w-full text-left px-4 py-3"
          :class="{ 'conv-item-active': conv.id === selectedId }"
          @click="selectConversation(conv.id)"
        >
          <div class="flex items-center gap-2">
            <span
              class="flex-shrink-0 inline-block w-2 h-2 rounded-full"
              :class="conv.status === 'active' ? 'bg-emerald-400' : 'bg-slate-400'"
            />
            <span class="text-xs text-slate-500 truncate">{{ formatWhen(conv.lastActiveAt) }}</span>
            <span class="ml-auto text-xs text-slate-400 flex-shrink-0">{{ conv.messageCount }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-700 dark:text-slate-300 conv-preview">
            {{ conv.preview || conv.id }}
          </p>
        </button>
        <button
          v-if="hasMore"
          type="button"
          class="conv-more w-full px-4 py-3 text-xs"
          :disabled="listLoading"
          @click="loadMore"
        >
          {{ listLoading ? 'Loading…' : 'Load older' }}
        </button>
      </aside>

      <!-- Transcript -->
      <section
        ref="transcriptEl"
        class="flex-1 min-w-0 overflow-auto px-6 py-4"
        @scroll="onTranscriptScroll"
      >
        <p
          v-if="!selectedId"
          class="text-sm text-slate-500 py-10 text-center"
        >
          Select a conversation.
        </p>
        <p
          v-else-if="detailLoading && !detail"
          class="text-sm text-slate-500 py-10 text-center"
        >
          Loading…
        </p>
        <template v-else-if="detail">
          <div class="mb-4">
            <p class="text-xs text-slate-500 font-mono break-all">
              {{ detail.id }}
            </p>
            <p class="text-xs text-slate-500 mt-0.5">
              {{ detail.status }} · started {{ formatWhen(detail.createdAt) }} · last active {{ formatWhen(detail.lastActiveAt) }}
            </p>
          </div>
          <p
            v-if="detail.missingLog"
            class="text-sm text-slate-500"
          >
            This conversation is indexed in the database, but its message log file is missing.
          </p>
          <p
            v-else-if="!detail.entries.length"
            class="text-sm text-slate-500"
          >
            No messages logged yet.
          </p>
          <p
            v-if="detail.truncated"
            class="text-xs text-slate-500 mb-3"
          >
            Showing the most recent part of a long conversation.
          </p>

          <div class="space-y-3">
            <template
              v-for="(entry, i) in detail.entries"
              :key="i"
            >
              <div
                v-if="entry.kind === 'event'"
                class="conv-event text-xs text-slate-500"
              >
                {{ entry.text }} · {{ formatClock(entry.ts) }}
              </div>

              <details
                v-else-if="entry.kind === 'tool'"
                class="conv-tool text-xs"
              >
                <summary class="cursor-pointer text-slate-600 dark:text-slate-400">
                  <span class="font-mono">{{ entry.toolName }}</span>
                  <span class="text-slate-400"> · {{ formatClock(entry.ts) }}</span>
                </summary>
                <pre class="conv-pre mt-2">{{ entry.text }}</pre>
              </details>

              <div
                v-else
                class="conv-msg rounded-lg px-4 py-3"
                :class="entry.kind === 'user' ? 'conv-msg-user' : 'conv-msg-assistant'"
              >
                <p class="text-xs text-slate-500 mb-1">
                  {{ entry.kind === 'user' ? 'Prompt' : agentName }} · {{ formatClock(entry.ts) }}
                </p>
                <div
                  v-if="entry.kind === 'assistant'"
                  class="conv-markdown text-sm"
                  v-html="renderMarkdown(entry.text)"
                />
                <template v-else>
                  <pre class="conv-pre conv-user-text text-sm">{{ isExpanded(i) ? entry.text : clip(entry.text) }}</pre>
                  <button
                    v-if="entry.text.length > CLIP_CHARS"
                    type="button"
                    class="conv-toggle text-xs mt-1"
                    @click="toggleExpanded(i)"
                  >
                    {{ isExpanded(i) ? 'Show less' : 'Show full prompt' }}
                  </button>
                </template>
              </div>
            </template>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

import type { AgentConversationDetail, AgentConversationSummary } from '@pkg/main/agentsIpc';
import { renderMarkdown } from '@pkg/pages/chat/messages/markdown';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{
  channel:   string;
  agentName: string;
  /** Bumped by the parent's poll timer; triggers a refresh. */
  tick:      number;
  /** Opens a single known conversation without the agent-wide list. */
  conversationId?: string;
}>();

defineEmits<{ close: [] }>();

const PAGE_SIZE = 50;
const CLIP_CHARS = 1200;

const conversations = ref<AgentConversationSummary[]>([]);
const hasMore = ref(false);
const listLoading = ref(false);
const selectedId = ref<string | null>(props.conversationId ?? null);
const detail = ref<AgentConversationDetail | null>(null);
const detailLoading = ref(false);
const expanded = ref(new Set<number>());
const transcriptEl = ref<HTMLElement | null>(null);
let stickToBottom = true;

async function fetchPage(offset: number, limit: number): Promise<AgentConversationSummary[]> {
  try {
    return await ipcRenderer.invoke('agents:conversations' as any, props.channel, limit, offset);
  } catch {
    return [];
  }
}

/** Reload the visible list (keeps however many pages are loaded). */
async function refreshList() {
  listLoading.value = true;
  const limit = Math.max(PAGE_SIZE, conversations.value.length);
  const rows = await fetchPage(0, limit);

  conversations.value = rows;
  hasMore.value = rows.length >= limit;
  listLoading.value = false;

  if (!selectedId.value && rows.length) selectConversation(rows[0].id);
}

async function loadMore() {
  listLoading.value = true;
  const rows = await fetchPage(conversations.value.length, PAGE_SIZE);

  conversations.value = [...conversations.value, ...rows];
  hasMore.value = rows.length >= PAGE_SIZE;
  listLoading.value = false;
}

async function loadDetail() {
  const id = selectedId.value;

  if (!id) return;
  detailLoading.value = true;
  let next: AgentConversationDetail | null = null;

  try {
    next = await ipcRenderer.invoke('agents:conversation' as any, id);
  } catch {
    next = null;
  }
  // Ignore a stale response if the selection changed mid-request.
  if (id !== selectedId.value) return;
  const grew = (next?.entries.length ?? 0) !== (detail.value?.entries.length ?? 0);

  detail.value = next;
  detailLoading.value = false;

  if (grew && stickToBottom) {
    await nextTick();
    scrollToBottom();
  }
}

function selectConversation(id: string) {
  if (id === selectedId.value) return;
  selectedId.value = id;
  detail.value = null;
  expanded.value = new Set();
  stickToBottom = true;
  loadDetail();
}

function scrollToBottom() {
  const el = transcriptEl.value;

  if (el) el.scrollTop = el.scrollHeight;
}

function onTranscriptScroll() {
  const el = transcriptEl.value;

  if (el) stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function clip(text: string): string {
  return text.length > CLIP_CHARS ? `${ text.slice(0, CLIP_CHARS) }…` : text;
}

function isExpanded(i: number): boolean {
  return expanded.value.has(i);
}

function toggleExpanded(i: number) {
  const next = new Set(expanded.value);

  if (next.has(i)) next.delete(i); else next.add(i);
  expanded.value = next;
}

function formatWhen(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) return iso;

  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatClock(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) return '';

  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

watch(() => props.channel, () => {
  if (props.conversationId) return;
  conversations.value = [];
  selectedId.value = null;
  detail.value = null;
  refreshList();
});

watch(() => props.conversationId, (id) => {
  selectedId.value = id ?? null;
  detail.value = null;
  expanded.value = new Set();
  if (id) loadDetail(); else refreshList();
});

watch(() => props.tick, async() => {
  if (props.conversationId) {
    await loadDetail();
    return;
  }
  await refreshList();
  // Re-read the open log only when the index says it moved — many rows stay
  // 'active' long after their agent finished, and logs can be large.
  const current = conversations.value.find(c => c.id === selectedId.value);

  if (detail.value && current && current.lastActiveAt !== detail.value.lastActiveAt) loadDetail();
});

onMounted(() => props.conversationId ? loadDetail() : refreshList());
</script>

<style scoped>
.conv-toolbar,
.conv-list {
  border-color: rgba(100, 116, 139, 0.2);
}

.conv-toolbar {
  border-bottom-width: 1px;
}

.conv-list {
  width: 320px;
  border-right-width: 1px;
}

.conv-back {
  font-size: 0.75rem;
  color: #5096b3;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
}

.conv-back:hover {
  background: rgba(80, 150, 179, 0.12);
}

.conv-item {
  border-bottom: 1px solid rgba(100, 116, 139, 0.12);
}

.conv-item:hover {
  background: rgba(100, 116, 139, 0.06);
}

.conv-item-active {
  background: rgba(80, 150, 179, 0.12);
}

.conv-preview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.conv-more {
  color: #5096b3;
}

.conv-event {
  text-align: center;
}

.conv-tool {
  padding: 0.25rem 0.75rem;
  border-left: 2px solid rgba(100, 116, 139, 0.3);
}

.conv-msg-user {
  background: rgba(100, 116, 139, 0.08);
}

.conv-msg-assistant {
  background: rgba(80, 150, 179, 0.08);
}

.conv-pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  margin: 0;
}

.conv-user-text {
  font-family: inherit;
  font-size: 0.875rem;
}

.conv-toggle {
  color: #5096b3;
}

.conv-markdown :deep(p) {
  margin: 0.4em 0;
}

.conv-markdown :deep(pre) {
  white-space: pre-wrap;
  font-size: 0.75rem;
  background: rgba(100, 116, 139, 0.1);
  padding: 0.5rem;
  border-radius: 6px;
}

.conv-markdown :deep(ul),
.conv-markdown :deep(ol) {
  padding-left: 1.25rem;
  list-style: revert;
}

.theme-noir .conv-root {
  background:
    radial-gradient(circle at 80% 0%, color-mix(in srgb, var(--nx-accent) 7%, transparent), transparent 32%),
    var(--nx-paper);
  color: var(--nx-read-2);
}

.theme-noir .conv-toolbar {
  min-height: 72px;
  border-color: var(--nx-hair);
  background: color-mix(in srgb, var(--bg-surface-alt) 68%, transparent);
  backdrop-filter: blur(18px);
}

.theme-noir .conv-toolbar p:first-of-type {
  color: var(--nx-read-1);
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 1.15rem;
}

.theme-noir .conv-toolbar p:last-of-type {
  color: var(--nx-read-4);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
}

.theme-noir .conv-back {
  border: 1px solid var(--nx-hair);
  border-radius: 999px;
  background: color-mix(in srgb, var(--nx-hair-strong) 21.875%, transparent);
  color: var(--text-info);
}

.theme-noir .conv-list {
  width: 350px;
  padding: 14px;
  border-color: var(--nx-hair);
  background: color-mix(in srgb, var(--bg-surface-alt) 45%, transparent);
}

.theme-noir .conv-item {
  margin-bottom: 8px;
  border: 1px solid var(--nx-hair);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nx-hair-strong) 15.625%, transparent);
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
}

.theme-noir .conv-item:hover,
.theme-noir .conv-item-active {
  transform: translateX(3px);
  border-color: color-mix(in srgb, var(--nx-accent-2) 24%, transparent);
  background: color-mix(in srgb, var(--nx-accent) 8.5%, transparent);
}

.theme-noir .conv-preview {
  color: var(--nx-read-3);
  line-height: 1.5;
}

.theme-noir .conv-event {
  color: var(--nx-read-5);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.64rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.theme-noir .conv-tool {
  padding: 11px 14px;
  border: 1px solid var(--nx-hair);
  border-left: 3px solid var(--nx-accent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-surface-alt) 72%, transparent);
}

.theme-noir .conv-msg {
  border: 1px solid var(--nx-hair);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-on-accent) 2.5%, transparent);
}

.theme-noir .conv-msg-user {
  margin-left: clamp(2rem, 14vw, 12rem);
  background: linear-gradient(135deg, color-mix(in srgb, var(--nx-accent) 16%, transparent), color-mix(in srgb, var(--nx-accent) 6%, transparent));
}

.theme-noir .conv-msg-assistant {
  margin-right: clamp(1rem, 8vw, 7rem);
  background: color-mix(in srgb, var(--nx-hair-strong) 20%, transparent);
}

.theme-noir .conv-msg > p:first-child {
  color: var(--nx-read-4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.theme-noir .conv-markdown :deep(pre) {
  border: 1px solid var(--nx-hair);
  background: color-mix(in srgb, var(--nx-paper) 72%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .conv-item {
    transition: none;
  }
}
</style>
