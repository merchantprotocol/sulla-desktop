<!--
  User-authored message. Staged attachments render above the body.
-->
<template>
  <div class="chat-turn you chat-fade-in">
    <span class="chat-role">You · {{ timeLabel }}</span>
    <div v-if="msg.attachments?.length" class="attachments">
      <span v-for="att in msg.attachments" :key="att.id" class="att-chip">
        <span class="ic">{{ iconFor(att.kind) }}</span>
        <span class="name">{{ att.name }}</span>
        <span class="size">{{ att.size }}</span>
      </span>
    </div>
    <div class="chat-body">{{ msg.text }}</div>
    <TurnActions
      role="you"
      :pinned="msg.pinned"
      @edit="$emit('edit')"
      @copy="copy"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UserMessage } from '../../models/Message';
import TurnActions from './TurnActions.vue';

const props = defineProps<{ msg: UserMessage }>();
defineEmits<{ (e: 'edit'): void }>();

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
});

function iconFor(kind: string): string {
  return ({ image: '▣', json: '◆', ts: '‹›', md: '¶', log: '≡' } as Record<string, string>)[kind] || '◇';
}

function copy(): void {
  void navigator.clipboard?.writeText(props.msg.text);
}
</script>

<style scoped>
.attachments {
  display: flex; gap: 8px; flex-wrap: wrap;
  justify-content: flex-end; margin-bottom: 12px;
}
.att-chip {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 6px 12px; border-radius: 100px;
  background: rgba(168, 192, 220, 0.08);
  border: 1px solid rgba(168, 192, 220, 0.22);
  font-family: var(--mono); font-size: 11px; color: var(--read-2);
}
.att-chip .ic   { color: var(--steel-400); font-size: 12px; }
.att-chip .name { font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-chip .size { color: var(--read-4); font-size: 10.5px; }
</style>
