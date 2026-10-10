<template>
  <div class="heartbeat-control">
    <button
      type="button"
      class="heartbeat-trigger"
      :class="{ enabled: status.enabled }"
      :aria-expanded="open"
      title="Chat heartbeat"
      @click="open = !open"
    >
      <span aria-hidden="true">♥</span>
      <span>{{ status.enabled ? countdown : 'off' }}</span>
    </button>

    <form
      v-if="open"
      class="heartbeat-popover"
      @submit.prevent="save"
    >
      <div class="heartbeat-title">
        Chat heartbeat
      </div>
      <label>
        <span>Wake every</span>
        <select v-model="choice">
          <option value="off">Off</option>
          <option
            v-for="minutes in presets"
            :key="minutes"
            :value="String(minutes)"
          >{{ minutes }} min</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label v-if="choice === 'custom'">
        <span>Minutes</span>
        <input
          v-model.number="customMinutes"
          type="number"
          min="0.1"
          max="1440"
          step="0.1"
        >
      </label>
      <label>
        <span>Message</span>
        <textarea
          v-model="draftMessage"
          rows="5"
        />
      </label>
      <div class="heartbeat-actions">
        <button
          type="button"
          class="off-button"
          @click="turnOff"
        >
          Turn off
        </button>
        <button
          type="submit"
          class="save-button"
        >
          Save
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { newMessageId } from '../../types/chat';

import {
  DEFAULT_CHAT_HEARTBEAT_MESSAGE,
  defaultChatHeartbeatConfig,
  normalizeChatHeartbeatConfig,
  type ChatHeartbeatBeat,
  type ChatHeartbeatConfig,
  type ChatHeartbeatStatus,
} from '@pkg/shared/chatHeartbeat';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { HeartbeatMessage } from '../../models/Message';

const controller = useChatController();
const presets = [1, 2, 5, 10, 15, 30, 60];
const open = ref(false);
const now = ref(Date.now());
const choice = ref('off');
const customMinutes = ref(5);
const draftMessage = ref(DEFAULT_CHAT_HEARTBEAT_MESSAGE);
const status = ref<ChatHeartbeatStatus>({
  threadId: '',
  enabled:  false,
  nextAt:   null,
  pending:  false,
  ...defaultChatHeartbeatConfig(),
});
let registeredThreadId = '';
let clock: ReturnType<typeof setInterval> | null = null;

const backendThreadId = computed(() => controller.thread.value.backendThreadId ?? '');
const countdown = computed(() => {
  if (status.value.pending) return 'pending';
  if (!status.value.nextAt) return 'on';
  const seconds = Math.max(0, Math.ceil((status.value.nextAt - now.value) / 1_000));
  return `next in ${ Math.floor(seconds / 60) }:${ String(seconds % 60).padStart(2, '0') }`;
});

function syncForm(config: ChatHeartbeatConfig): void {
  const minutes = config.intervalMinutes;
  choice.value = minutes === null ? 'off' : presets.includes(minutes) ? String(minutes) : 'custom';
  if (minutes !== null && !presets.includes(minutes)) customMinutes.value = minutes;
  draftMessage.value = config.message;
}

async function register(threadId: string): Promise<void> {
  if (!threadId) return;
  if (registeredThreadId && registeredThreadId !== threadId) {
    await ipcRenderer.invoke('chat-heartbeat:unregister', registeredThreadId).catch(() => undefined);
  }
  registeredThreadId = threadId;
  const result = await ipcRenderer.invoke('chat-heartbeat:register', {
    threadId,
    channel: 'sulla-desktop',
    config:  controller.heartbeat.value,
    busy:    controller.isRunning.value,
  });
  if (result?.success && result.status) status.value = result.status;
  syncForm(controller.heartbeat.value);
}

async function apply(config: ChatHeartbeatConfig): Promise<void> {
  const normalized = normalizeChatHeartbeatConfig(config);
  controller.setHeartbeat(normalized);
  syncForm(normalized);
  if (registeredThreadId) {
    const result = await ipcRenderer.invoke('chat-heartbeat:set', { threadId: registeredThreadId, config: normalized });
    if (result?.success && result.status) status.value = result.status;
  }
  open.value = false;
}

async function save(): Promise<void> {
  const intervalMinutes = choice.value === 'off'
    ? null
    : choice.value === 'custom'
      ? Number(customMinutes.value)
      : Number(choice.value);
  await apply({ intervalMinutes, message: draftMessage.value });
}

async function turnOff(): Promise<void> {
  await apply({ intervalMinutes: null, message: draftMessage.value });
}

function onStatus(_event: unknown, value: ChatHeartbeatStatus): void {
  if (value?.threadId === registeredThreadId) status.value = value;
}

function onConfig(_event: unknown, value: { threadId: string; config: ChatHeartbeatConfig }): void {
  if (value?.threadId !== registeredThreadId) return;
  const config = normalizeChatHeartbeatConfig(value.config);
  controller.setHeartbeat(config);
  syncForm(config);
}

function onBeat(_event: unknown, beat: ChatHeartbeatBeat): void {
  if (beat?.threadId !== registeredThreadId) return;
  controller.appendHeartbeat({
    id:              newMessageId(),
    kind:            'heartbeat',
    createdAt:       beat.createdAt,
    intervalMinutes: beat.intervalMinutes,
    text:            beat.message,
  } satisfies HeartbeatMessage);
}

watch(backendThreadId, threadId => { register(threadId).catch(() => undefined) }, { immediate: true });
watch(() => controller.isRunning.value, busy => {
  if (registeredThreadId) ipcRenderer.invoke('chat-heartbeat:busy', { threadId: registeredThreadId, busy }).catch(() => undefined);
});

onMounted(() => {
  ipcRenderer.on('chat-heartbeat:status', onStatus);
  ipcRenderer.on('chat-heartbeat:config', onConfig);
  ipcRenderer.on('chat-heartbeat:beat', onBeat);
  clock = setInterval(() => { now.value = Date.now() }, 1_000);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('chat-heartbeat:status', onStatus);
  ipcRenderer.removeListener('chat-heartbeat:config', onConfig);
  ipcRenderer.removeListener('chat-heartbeat:beat', onBeat);
  if (clock) clearInterval(clock);
  if (registeredThreadId) ipcRenderer.invoke('chat-heartbeat:unregister', registeredThreadId).catch(() => undefined);
});
</script>

<style scoped>
.heartbeat-control { position: relative; margin-right: auto; letter-spacing: normal; text-transform: none; }
.heartbeat-trigger {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-muted); border-radius: 999px;
  padding: 3px 8px; background: var(--surface-1); color: var(--text-muted);
  font: inherit; cursor: pointer;
}
.heartbeat-trigger.enabled { color: var(--accent); border-color: var(--accent-border); background: var(--accent-dim); }
.heartbeat-popover {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30;
  width: min(360px, 80vw); padding: 14px; border-radius: 12px;
  background: var(--surface-1); color: var(--text); border: 1px solid var(--border);
  box-shadow: var(--shadow-lg); font-family: var(--font-body); font-size: 12px;
}
.heartbeat-title { margin-bottom: 12px; font-weight: 700; }
label { display: grid; gap: 6px; margin-top: 10px; color: var(--text-muted); }
select, input, textarea {
  width: 100%; box-sizing: border-box; border: 1px solid var(--border-muted); border-radius: 8px;
  padding: 8px; background: var(--surface-2); color: var(--text); font: inherit;
}
textarea { resize: vertical; line-height: 1.4; }
.heartbeat-actions { display: flex; justify-content: space-between; gap: 8px; margin-top: 12px; }
.heartbeat-actions button { border: 1px solid var(--border-muted); border-radius: 8px; padding: 7px 10px; font: inherit; cursor: pointer; }
.off-button { background: var(--surface-2); color: var(--text-muted); }
.save-button { background: var(--accent); color: var(--bg); border-color: var(--accent); }
</style>
