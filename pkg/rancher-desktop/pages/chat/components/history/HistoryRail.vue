<!--
  Left-side history rail. Lists open + persisted threads grouped
  by Today / Yesterday / This week.
  Clicking a row activates that thread's controller.
-->
<template>
  <aside v-if="open" class="history">
    <div class="history-head">Recent</div>
    <div class="history-list">
      <template v-for="group in grouped" :key="group.label">
        <div class="history-day">{{ group.label }}</div>
        <div
          v-for="t in group.items"
          :key="t.id"
          :class="['history-item', { active: t.id === activeId }]"
          @click="$emit('activate', t.id)"
        >
          <span>{{ t.title || 'Untitled' }}</span>
          <span class="date">{{ formatTime(t.updatedAt) }}</span>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Thread }    from '../../models/Thread';
import type { ThreadId }  from '../../types/chat';

const props = defineProps<{
  open:     boolean;
  threads:  Thread[];
  activeId: ThreadId | null;
}>();
defineEmits<{ (e: 'activate', id: ThreadId): void }>();

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
.history-list { flex: 1; overflow-y: auto; padding: 8px 10px 20px; }
.history-item {
  padding: 10px 12px; border-radius: 8px;
  font-family: var(--serif); font-style: italic;
  font-size: 14px; color: var(--read-3);
  cursor: pointer; transition: all 0.15s ease;
  display: flex; align-items: baseline; gap: 10px;
}
.history-item:hover { background: rgba(80, 150, 179, 0.08); color: var(--read-2); }
.history-item.active { background: rgba(80, 150, 179, 0.14); color: var(--read-1); }
.history-item .date {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em;
  color: var(--read-5); font-style: normal; margin-left: auto;
}
.history-day {
  padding: 14px 14px 6px;
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--read-4);
}
</style>
