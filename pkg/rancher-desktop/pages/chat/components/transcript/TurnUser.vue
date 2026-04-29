<!--
  User-authored message. Staged attachments render above the body.

  Hover actions:
    • Edit → opens an inline EditOverlay; Save commits + regenerates
             (trims subsequent messages and re-sends through the backend).
    • Copy → copies message text to clipboard.

  Right-click → opens the shared ChatContextMenu anchored at the cursor.
-->
<template>
  <div
    class="chat-turn you chat-fade-in"
    @contextmenu.prevent="onContextMenu"
  >
    <span class="chat-role">You · {{ timeLabel }}</span>
    <div v-if="msg.attachments?.length" class="attachments">
      <span v-for="att in msg.attachments" :key="att.id" class="att-chip">
        <span class="ic">{{ iconFor(att.kind) }}</span>
        <span class="name">{{ att.name }}</span>
        <span class="size">{{ att.size }}</span>
      </span>
    </div>

    <div class="body-wrap">
      <div class="chat-body" :class="{ 'is-editing': editing }">{{ msg.text }}</div>
      <EditOverlay
        v-if="editing"
        :message-id="msg.id"
        :initial-text="msg.text"
        @save="onSaveEdit"
        @cancel="editing = false"
      />
    </div>

    <TurnActions
      role="you"
      :pinned="msg.pinned"
      @edit="editing = true"
      @copy="copy"
    />

    <ChatContextMenu ref="ctxMenu" @new-chat="onNewChat" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { UserMessage } from '../../models/Message';
import TurnActions from './TurnActions.vue';
import EditOverlay from './EditOverlay.vue';
import ChatContextMenu from '../../ChatContextMenu.vue';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: UserMessage }>();
// Retained so existing parents that listen to @edit continue to compile.
defineEmits<{ (e: 'edit'): void }>();

const controller = useChatController();

const editing = ref(false);

const ctxMenu = ref<InstanceType<typeof ChatContextMenu> | null>(null);

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

function onSaveEdit(payload: { id: string; text: string }): void {
  controller.editMessage(payload.id, payload.text);
  controller.regenerate(payload.id);
  editing.value = false;
}

function onContextMenu(ev: MouseEvent): void {
  ctxMenu.value?.show(ev, props.msg.text);
}

function onNewChat(): void {
  window.dispatchEvent(new CustomEvent('chat:new-chat'));
}
</script>

<style scoped>
.body-wrap {
  position: relative;
}
.chat-body {
  white-space: pre-wrap;
}
.chat-body.is-editing {
  opacity: 0.35;
  filter: blur(1px);
  pointer-events: none;
  user-select: none;
}
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
