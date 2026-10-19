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
    <div
      v-if="msg.attachments?.length"
      class="attachments"
    >
      <ChatAttachmentChip
        v-for="att in msg.attachments"
        :key="att.id"
        :attachment="att"
      />
    </div>

    <div class="body-wrap">
      <div
        class="chat-body"
        :class="{ 'is-editing': editing }"
      >
        {{ msg.text }}
      </div>
      <small class="noir-time">{{ timeLabel }}</small>
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

    <ChatContextMenu
      ref="ctxMenu"
      @new-chat="onNewChat"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import EditOverlay from './EditOverlay.vue';
import TurnActions from './TurnActions.vue';
import ChatContextMenu from '../../ChatContextMenu.vue';
import { useChatController } from '../../controller/useChatController';
import ChatAttachmentChip from '../files/ChatAttachmentChip.vue';

import type { UserMessage } from '../../models/Message';

const props = defineProps<{ msg: UserMessage }>();
// Retained so existing parents that listen to @edit continue to compile.
defineEmits<(e: 'edit') => void>();

const controller = useChatController();

const editing = ref(false);

const ctxMenu = ref<InstanceType<typeof ChatContextMenu> | null>(null);

const timeLabel = computed(() => {
  const d = new Date(props.msg.createdAt);
  return `${ d.getHours() % 12 || 12 }:${ String(d.getMinutes()).padStart(2, '0') }`;
});

function copy(): void {
  navigator.clipboard?.writeText(props.msg.text).catch(() => undefined);
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
.noir-time { display: none; }
.attachments {
  display: flex; gap: 8px; flex-wrap: wrap;
  justify-content: flex-end; margin-bottom: 12px;
}
</style>
