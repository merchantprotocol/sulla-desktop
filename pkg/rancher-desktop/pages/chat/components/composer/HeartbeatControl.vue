<template>
  <div
    ref="root"
    class="heartbeat-control"
  >
    <button
      type="button"
      class="heartbeat-heart"
      :class="{ enabled: isOn, paused: isOn && (status.paused || controller.isRunning.value) }"
      :title="`Chat heartbeat — ${label}`"
      :aria-label="`Chat heartbeat: ${label}`"
      :aria-expanded="open"
      @click="open = !open"
    >
      ♥
    </button>

    <form
      v-if="open"
      class="heartbeat-popover"
      @submit.prevent="save"
    >
      <div class="heartbeat-header">
        <span class="heartbeat-title">Chat heartbeat</span>
        <button
          type="button"
          role="switch"
          class="heartbeat-switch"
          :class="{ enabled: isOn }"
          :aria-checked="isOn"
          :title="isOn ? 'Turn chat heartbeat off' : 'Turn chat heartbeat on'"
          @click="toggle"
        >
          <span class="switch-label">{{ isOn ? 'On' : 'Off' }}</span>
          <span class="track"><span class="thumb" /></span>
        </button>
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
const DEFAULT_MINUTES = 5;
const open = ref(false);
const root = ref<HTMLElement | null>(null);
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
  if (status.value.paused || controller.isRunning.value) return 'paused while running';
  if (status.value.pending) return 'retrying';
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
      // Plain copy — IPC can't structured-clone Vue's reactive proxy.
      config:  normalizeChatHeartbeatConfig(controller.heartbeat.value),
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

function draftMinutes(): number {
  return choice.value === 'custom' ? Number(customMinutes.value) : Number(choice.value);
}

// Save keeps the switch where it is; while off it only remembers the
// interval for the next time the switch is turned on.
async function save(): Promise<void> {
  if (!isOn.value) lastMinutes.value = draftMinutes();
  await apply({ intervalMinutes: isOn.value ? draftMinutes() : null, message: draftMessage.value });
  open.value = false;
}

// The switch applies immediately and leaves the panel open.
async function toggle(): Promise<void> {
  if (isOn.value) {
    await apply({ intervalMinutes: null, message: draftMessage.value });
    return;
  }
  lastMinutes.value = draftMinutes();
  await apply({ intervalMinutes: lastMinutes.value, message: draftMessage.value });
}

function onPointerDown(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
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
  document.addEventListener('pointerdown', onPointerDown);
  clock = setInterval(() => { now.value = Date.now() }, 1_000);
});

onBeforeUnmount(() => {
  ipcRenderer.removeListener('chat-heartbeat:status', onStatus);
  ipcRenderer.removeListener('chat-heartbeat:config', onConfig);
  ipcRenderer.removeListener('chat-heartbeat:beat', onBeat);
  document.removeEventListener('pointerdown', onPointerDown);
  if (clock) clearInterval(clock);
  if (registeredThreadId) ipcRenderer.invoke('chat-heartbeat:unregister', registeredThreadId).catch(() => undefined);
});
</script>

<style scoped>
.heartbeat-control { position: relative; display: inline-flex; align-items: center; letter-spacing: normal; text-transform: none; }
/* Just a heart: grey when off, red and slowly beating when on. */
.heartbeat-heart {
  padding: 0 2px; border: 0; background: transparent; font-size: 16px; line-height: 1;
  color: var(--text-dim); opacity: 0.6; cursor: pointer;
}
.heartbeat-heart:hover { opacity: 1; }
.heartbeat-heart.enabled { color: var(--danger); opacity: 1; animation: heartbeat-blink 2.4s ease-in-out infinite; }
@keyframes heartbeat-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .heartbeat-heart.enabled { animation: none; }
}
.theme-noir .heartbeat-heart {
  display: grid; place-items: center; width: 34px; height: 34px; padding: 0;
  border-radius: 50%; color: var(--nx-read-4); opacity: 1; font-size: 15px;
}
.theme-noir .heartbeat-heart:hover { color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 12%, transparent); }
.theme-noir .heartbeat-heart.enabled {
  color: var(--nx-accent-2); text-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent-2) 70%, transparent);
  animation: noir-heartbeat 1.4s cubic-bezier(.22, 1, .36, 1) infinite;
}
@keyframes noir-heartbeat {
  0%, 40%, 100% { transform: scale(1); }
  15% { transform: scale(1.22); }
  28% { transform: scale(1.08); }
}
.theme-noir .heartbeat-popover {
  left: 0; right: auto; bottom: calc(100% + 12px); border-color: var(--nx-hair-strong);
  border-radius: 18px; color: var(--nx-read-2); background: rgba(12, 18, 28, 0.98);
}
.theme-noir-light .heartbeat-popover { background: color-mix(in srgb, var(--nx-surface) 98%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .theme-noir .heartbeat-heart.enabled { animation: none; }
}
/* On, but the graph is running — the heart rests until it stops. */
.heartbeat-heart.enabled.paused,
.theme-noir .heartbeat-heart.enabled.paused { animation: none; opacity: 0.55; text-shadow: none; }
.heartbeat-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.heartbeat-switch {
  display: inline-flex; align-items: center; gap: 8px; padding: 2px 0;
  border: 0; background: transparent; color: var(--text-muted); font: inherit; cursor: pointer;
}
.heartbeat-switch.enabled { color: var(--accent); }
.track {
  position: relative; width: 34px; height: 20px; border-radius: 999px;
  background: var(--surface-3); border: 1px solid var(--border); transition: background 0.15s;
}
.thumb {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: var(--text-muted); transition: transform 0.15s, background 0.15s;
}
.heartbeat-switch.enabled .track { background: var(--accent); border-color: var(--accent); }
.heartbeat-switch.enabled .thumb { transform: translateX(14px); background: var(--bg); }
.heartbeat-error { margin-top: 10px; color: var(--warning); }
.heartbeat-popover {
  position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 30;
  width: min(360px, 80vw); padding: 14px; border-radius: 12px;
  background: var(--surface-1); color: var(--text); border: 1px solid var(--border);
  box-shadow: var(--shadow-lg); font-family: var(--font-body); font-size: 12px;
}
.heartbeat-title { font-weight: 700; }
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
