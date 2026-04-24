<!--
  Left-side history rail.
    • Pinned messages (Pinboard) sit at the top — jump straight to the turn.
    • Threads grouped by Today / Yesterday / This week / Earlier below.
  Clicking a thread row activates that thread's controller; clicking a
  pinned message emits `jump-to` with { threadId, messageId }.
-->
<template>
  <aside v-if="open" class="history">
    <!-- ─── Pinboard ─── -->
    <template v-if="pinned.length > 0">
      <div class="history-head">Pinned</div>
      <div class="history-list">
        <div
          v-for="p in pinned"
          :key="p.messageId"
          class="history-item pinned"
          :title="p.preview"
          @click="$emit('jump-to', { threadId: p.threadId, messageId: p.messageId })"
        >
          <span class="pin-icon">◈</span>
          <span class="pin-body">
            <span class="pin-text">{{ p.preview }}</span>
            <span class="pin-origin">from {{ p.threadTitle || 'Untitled' }}</span>
          </span>
        </div>
      </div>
    </template>

    <!-- ─── Recent threads ─── -->
    <div class="history-head">Recent</div>
    <div class="history-list">
      <template v-for="group in grouped" :key="group.label">
        <div class="history-day">{{ group.label }}</div>
        <div
          v-for="t in group.items"
          :key="t.id"
          :class="['history-item', {
            active:    t.id === activeId,
            archived: !isRehydratable(t.id),
          }]"
          :title="isRehydratable(t.id) ? '' : 'Archived — conversation text not available in this session'"
          @click="onRowClick(t.id)"
        >
          <span class="row-title">
            <span v-if="!isRehydratable(t.id)" class="archived-mark" aria-hidden="true">◌</span>
            {{ t.title || 'Untitled' }}
          </span>
          <span class="date">{{ formatTime(t.updatedAt) }}</span>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Thread }    from '../../models/Thread';
import type { ThreadId, MessageId }  from '../../types/chat';

export interface PinnedEntry {
  threadId:    ThreadId;
  threadTitle: string;
  messageId:   MessageId;
  preview:     string;
}

const props = defineProps<{
  open:     boolean;
  threads:  Thread[];
  activeId: ThreadId | null;
  /** Pinned messages across all open/persisted threads. Rendered above the recent list. */
  pinned?:  readonly PinnedEntry[];
  /**
   * Ids that can be fully rehydrated (in-memory controllers + LocalStoragePersister
   * snapshots). Threads sourced only from the Postgres conversation_history table
   * aren't in this set and get rendered as archived / dim with a no-op click.
   */
  rehydratableIds?: ReadonlySet<ThreadId>;
}>();
const emit = defineEmits<{
  (e: 'activate', id: ThreadId): void;
  (e: 'jump-to', target: { threadId: ThreadId; messageId: MessageId }): void;
  (e: 'archived-click', id: ThreadId): void;
}>();

// Defaulted locally because readonly array defaults aren't friendly in props.
const pinned = computed<readonly PinnedEntry[]>(() => props.pinned ?? []);

function isRehydratable(id: ThreadId): boolean {
  // When the parent didn't pass a set, assume everything is rehydratable
  // so we don't regress existing behavior.
  return !props.rehydratableIds || props.rehydratableIds.has(id);
}

function onRowClick(id: ThreadId): void {
  if (isRehydratable(id)) emit('activate', id);
  else emit('archived-click', id);
}

function dayKey(t: number): string {
  const now = new Date();
  const d   = new Date(t);
  const nowMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dMid   = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.floor((nowMid - dMid) / (24 * 60 * 60 * 1000));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7)   return 'This week';
  return 'Earlier';
}
function formatTime(t: number): string {
  const d = new Date(t);
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return dayKey(t) === 'Today' ? `${ h }:${ m }` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const grouped = computed(() => {
  const groups = new Map<string, Thread[]>();
  for (const t of props.threads) {
    const k = dayKey(t.updatedAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const order = ['Today', 'Yesterday', 'This week', 'Earlier'];
  return order
    .filter(l => groups.has(l))
    .map(label => ({ label, items: groups.get(label)!.sort((a, b) => b.updatedAt - a.updatedAt) }));
});
</script>

<style scoped>
.history {
  overflow: hidden;
  border-right: 1px solid rgba(168, 192, 220, 0.08);
  background: rgba(7, 13, 26, 0.4);
  backdrop-filter: blur(8px);
  display: flex; flex-direction: column;
  height: 100%;
}
.history-head {
  padding: 22px 18px 12px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--steel-400);
  display: flex; align-items: center; gap: 10px;
}
.history-head::before {
  content: ""; width: 18px; height: 1px; background: var(--steel-500); opacity: 0.6;
}
/* Recent-list uses flex:1; pinned list is compact and doesn't grow. */
.history-list { overflow-y: auto; padding: 8px 10px 14px; }
.history-list:last-of-type { flex: 1; padding-bottom: 20px; }

.history-item {
  padding: 10px 12px; border-radius: 8px;
  font-family: var(--serif); font-style: italic;
  font-size: 14px; color: var(--read-3);
  cursor: pointer; transition: all 0.15s ease;
  display: flex; align-items: baseline; gap: 10px;
}
.history-item:hover { background: rgba(80, 150, 179, 0.08); color: var(--read-2); }
.history-item.active { background: rgba(80, 150, 179, 0.14); color: var(--read-1); }
.history-item.archived {
  opacity: 0.55;
  cursor: default;
}
.history-item.archived:hover {
  background: transparent;
  color: var(--read-3);
}
.archived-mark {
  color: var(--read-5);
  margin-right: 6px;
  font-style: normal;
  font-size: 10px;
  vertical-align: 1px;
}
.row-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.history-item .date {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em;
  color: var(--read-5); font-style: normal; margin-left: auto;
}

/* ─── Pinned-message row ─── */
.history-item.pinned {
  align-items: flex-start; gap: 10px;
  padding: 9px 12px;
  border-left: 2px solid rgba(80, 150, 179, 0.35);
  border-radius: 0 8px 8px 0;
  background: rgba(80, 150, 179, 0.04);
  font-style: normal;
}
.history-item.pinned:hover {
  background: rgba(80, 150, 179, 0.12);
  border-left-color: var(--steel-400);
}
.pin-icon {
  color: var(--steel-400); font-size: 12px;
  margin-top: 1px; flex-shrink: 0;
}
.pin-body {
  display: flex; flex-direction: column;
  gap: 2px; min-width: 0; flex: 1;
}
.pin-text {
  font-family: var(--serif); font-style: italic;
  font-size: 13px; color: var(--read-2);
  overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  line-height: 1.35;
}
.pin-origin {
  font-family: var(--mono); font-size: 9.5px;
  letter-spacing: 0.1em; color: var(--read-5);
}
.history-day {
  padding: 14px 14px 6px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--read-4);
}
</style>
