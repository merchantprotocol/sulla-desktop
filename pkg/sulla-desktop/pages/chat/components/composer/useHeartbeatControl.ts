// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref, type Ref } from 'vue';

import type { ChatController } from '../../controller/ChatController';
import {
  normalizeChatHeartbeatConfig,
  type ChatHeartbeatConfig,
  type ChatHeartbeatStatus,
} from '@pkg/shared/chatHeartbeat';

interface HeartbeatControlForm {
  presets: number[];
  choice: Ref<string>;
  customMinutes: Ref<number>;
  draftMessage: Ref<string>;
  lastMinutes: Ref<number>;
  status: Ref<ChatHeartbeatStatus>;
  error: Ref<string>;
}

type HeartbeatControlIpc = Pick<typeof import('@pkg/utils/ipcRenderer').ipcRenderer, 'invoke'>;

/** Owns the composer heartbeat's IPC-confirmed state transitions. */
export function useHeartbeatControl(controller: ChatController, backendThreadId: () => string,
  ipc: HeartbeatControlIpc, form: HeartbeatControlForm) {
  const registeredThreadId = ref('');

  const syncForm = (config: ChatHeartbeatConfig): void => {
    const minutes = config.intervalMinutes ?? form.lastMinutes.value;
    if (config.intervalMinutes !== null) form.lastMinutes.value = config.intervalMinutes;
    form.choice.value = form.presets.includes(minutes) ? String(minutes) : 'custom';
    if (!form.presets.includes(minutes)) form.customMinutes.value = minutes;
    form.draftMessage.value = config.message;
  };

  const errorText = (err: unknown): string => {
    const text = err instanceof Error ? err.message : String(err ?? '');
    if (/no handler registered/i.test(text)) return 'Heartbeat service isn\'t loaded — restart Sulla Desktop.';
    return text || 'Heartbeat service did not respond.';
  };

  const register = async(threadId: string): Promise<boolean> => {
    if (!threadId) return false;
    if (registeredThreadId.value && registeredThreadId.value !== threadId) {
      await ipc.invoke('chat-heartbeat:unregister', registeredThreadId.value).catch(() => undefined);
      registeredThreadId.value = '';
    }
    try {
      const result = await ipc.invoke('chat-heartbeat:register', {
        threadId,
        channel: 'sulla-desktop',
        config: normalizeChatHeartbeatConfig(controller.heartbeat.value),
        busy: controller.isRunning.value,
      });
      if (!result?.success) throw new Error(result?.error || 'register failed');
      registeredThreadId.value = threadId;
      form.status.value = result.status;
      form.error.value = '';
      return true;
    } catch (err) {
      form.error.value = errorText(err);
      return false;
    } finally {
      syncForm(controller.heartbeat.value);
    }
  };

  const apply = async(config: ChatHeartbeatConfig): Promise<void> => {
    const normalized = normalizeChatHeartbeatConfig({ ...config, startedAt: null, expiresAt: null, setBy: 'human' });
    syncForm(normalized);
    if (!registeredThreadId.value) {
      const registered = await register(backendThreadId());
      syncForm(normalized);
      if (!registered) {
        controller.setHeartbeat(normalized);
        if (!backendThreadId()) form.error.value = 'This chat has no backend thread yet — send a message first.';
        return;
      }
    }
    try {
      const result = await ipc.invoke('chat-heartbeat:set', { threadId: registeredThreadId.value, config: normalized });
      if (!result?.success) throw new Error(result?.error || 'update failed');
      form.status.value = result.status;
      // Persist only the deadline that the scheduler confirms.
      controller.confirmHeartbeat(result.status);
      syncForm(controller.heartbeat.value);
      form.error.value = '';
    } catch (err) {
      form.error.value = errorText(err);
      syncForm(controller.heartbeat.value);
    }
  };

  const onStatus = (_event: unknown, value: ChatHeartbeatStatus): void => {
    if (value?.threadId !== registeredThreadId.value) return;
    form.status.value = value;
    if (!value.enabled && controller.heartbeat.value.intervalMinutes !== null) {
      const config = normalizeChatHeartbeatConfig({ ...controller.heartbeat.value, intervalMinutes: null, startedAt: null, expiresAt: null });
      controller.setHeartbeat(config);
      syncForm(config);
    }
  };

  const onConfig = (_event: unknown, value: { threadId: string; config: ChatHeartbeatConfig }): void => {
    if (value?.threadId !== registeredThreadId.value) return;
    const config = normalizeChatHeartbeatConfig(value.config);
    controller.setHeartbeat(config);
    syncForm(config);
  };

  return { registeredThreadId, register, apply, onStatus, onConfig };
}
