<template>
  <div class="heartbeat-control">
    <div
      class="heartbeat-pill"
      :class="{ enabled: isOn, broken: !!error }"
    >
      <button
        type="button"
        role="switch"
        class="heartbeat-switch"
        :aria-checked="isOn"
        :title="isOn ? 'Turn chat heartbeat off' : 'Turn chat heartbeat on'"
        @click="toggle"
      >
        <span class="track"><span class="thumb" /></span>
        <span aria-hidden="true">♥</span>
        <span>{{ label }}</span>
      </button>
      <button
        type="button"
        class="heartbeat-settings"
        title="Heartbeat settings"
        :aria-expanded="open"
        @click="open = !open"
      >
        ⚙
      </button>
    </div>

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
      <div
        v-if="error"
        class="heartbeat-error"
      >
        {{ error }}
      </div>
      <div class="heartbeat-actions">
        <button
          type="button"
          class="off-button"
          @click="open = false"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="save-button"
        >
          {{ isOn ? 'Save' : 'Save & turn on' }}
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
const DEFAULT_MINUTES = 5;
const open = ref(false);
const now = ref(Date.now());
const choice = ref(String(DEFAULT_MINUTES));
const error = ref('');
// Interval the switch restores when turned back on.
const lastMinutes = ref(controller.heartbeat.value.intervalMinutes ?? DEFAULT_MINUTES);
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
// The switch follows the chat's saved config so it flips the moment you
// click; the label shows what the scheduler in main is actually doing.
const isOn = computed(() => controller.heartbeat.value.intervalMinutes !== null);
const label = computed(() => {
  if (!isOn.value) return 'off';
  if (error.value) return 'not running';
  if (!status.value.enabled) return 'starting…';
  return countdown.value;
});
const countdown = computed(() => {
  if (status.value.pending) return 'pending';
  if (!status.value.nextAt) return 'on';
  const seconds = Math.max(0, Math.ceil((status.value.nextAt - now.value) / 1_000));
  return `next in ${ Math.floor(seconds / 60) }:${ String(seconds % 60).padStart(2, '0') }`;
});

function syncForm(config: ChatHeartbeatConfig): void {
  const minutes = config.intervalMinutes ?? lastMinutes.value;
  if (config.intervalMinutes !== null) lastMinutes.value = config.intervalMinutes;
  choice.value = presets.includes(minutes) ? String(minutes) : 'custom';
  if (!presets.includes(minutes)) customMinutes.value = minutes;
  draftMessage.value = config.message;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? '');
  // A main process started before this feature existed has no handler.
  if (/no handler registered/i.test(text)) return 'Heartbeat service isn\'t loaded — restart Sulla Desktop.';
  return text || 'Heartbeat service did not respond.';
}

async function register(threadId: string): Promise<boolean> {
  if (!threadId) return false;
  if (registeredThreadId && registeredThreadId !== threadId) {
    await ipcRenderer.invoke('chat-heartbeat:unregister', registeredThreadId).catch(() => undefined);
    registeredThreadId = '';
  }
  try {
    const result = await ipcRenderer.invoke('chat-heartbeat:register', {
      threadId,
      channel: 'sulla-desktop',
      config:  controller.heartbeat.value,
      busy:    controller.isRunning.value,
    });
    if (!result?.success) throw new Error(result?.error || 'register failed');
    registeredThreadId = threadId;
    status.value = result.status;
    error.value = '';
    return true;
  } catch (err) {
    error.value = errorText(err);
    return false;
  } finally {
    syncForm(controller.heartbeat.value);
  }
}

async function apply(config: ChatHeartbeatConfig): Promise<void> {
  const normalized = normalizeChatHeartbeatConfig(config);
  controller.setHeartbeat(normalized);
  syncForm(normalized);
  open.value = false;
  // Register on demand — the chat may not have been registered yet (thread
  // id arrived late, or the first attempt failed).
  if (!registeredThreadId && !await register(backendThreadId.value)) {
    if (!backendThreadId.value) error.value = 'This chat has no backend thread yet — send a message first.';
    return;
  }
  try {
    const result = await ipcRenderer.invoke('chat-heartbeat:set', { threadId: registeredThreadId, config: normalized });
    if (!result?.success) throw new Error(result?.error || 'update failed');
    status.value = result.status;
    error.value = '';
  } catch (err) {
    error.value = errorText(err);
  }
}

async function save(): Promise<void> {
  const intervalMinutes = choice.value === 'custom' ? Number(customMinutes.value) : Number(choice.value);
  await apply({ intervalMinutes, message: draftMessage.value });
}

async function toggle(): Promise<void> {
  const message = controller.heartbeat.value.message;
  await apply({ intervalMinutes: isOn.value ? null : lastMinutes.value, message });
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
.heartbeat-pill {
  display: inline-flex; align-items: center;
  border: 1px solid var(--border-muted); border-radius: 999px;
  background: var(--surface-1); color: var(--text-muted);
}
.heartbeat-pill.enabled { color: var(--accent); border-color: var(--accent-border); background: var(--accent-dim); }
.heartbeat-pill.broken { color: var(--warning); border-color: var(--warning); }
.heartbeat-switch, .heartbeat-settings {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.heartbeat-switch { padding: 3px 4px 3px 6px; }
.heartbeat-settings { padding: 3px 8px 3px 4px; opacity: 0.7; }
.heartbeat-settings:hover { opacity: 1; }
.track {
  position: relative; width: 24px; height: 14px; border-radius: 999px;
  background: var(--surface-3); border: 1px solid var(--border); transition: background 0.15s;
}
.thumb {
  position: absolute; top: 1px; left: 1px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--text-muted); transition: transform 0.15s, background 0.15s;
}
.heartbeat-pill.enabled .track { background: var(--accent); border-color: var(--accent); }
.heartbeat-pill.enabled .thumb { transform: translateX(10px); background: var(--bg); }
.heartbeat-error { margin-top: 10px; color: var(--warning); }
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
