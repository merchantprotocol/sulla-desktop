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
export class HeartbeatControlState {
  readonly registeredThreadId = ref('');

  constructor(private readonly controller: ChatController, private readonly backendThreadId: () => string,
    private readonly ipc: HeartbeatControlIpc, private readonly form: HeartbeatControlForm) {}

  private syncForm(config: ChatHeartbeatConfig): void {
    const minutes = config.intervalMinutes ?? this.form.lastMinutes.value;
    if (config.intervalMinutes !== null) this.form.lastMinutes.value = config.intervalMinutes;
    this.form.choice.value = this.form.presets.includes(minutes) ? String(minutes) : 'custom';
    if (!this.form.presets.includes(minutes)) this.form.customMinutes.value = minutes;
    this.form.draftMessage.value = config.message;
  }

  private errorText(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err ?? '');
    if (/no handler registered/i.test(text)) return 'Heartbeat service isn\'t loaded — restart Sulla Desktop.';
    return text || 'Heartbeat service did not respond.';
  }

  async register(threadId: string): Promise<boolean> {
    if (!threadId) return false;
    if (this.registeredThreadId.value && this.registeredThreadId.value !== threadId) {
      await this.ipc.invoke('chat-heartbeat:unregister', this.registeredThreadId.value).catch(() => undefined);
      this.registeredThreadId.value = '';
    }
    try {
      const result = await this.ipc.invoke('chat-heartbeat:register', {
        threadId,
        channel: 'sulla-desktop',
        config: normalizeChatHeartbeatConfig(this.controller.heartbeat.value),
        busy: this.controller.isRunning.value,
      });
      if (!result?.success) throw new Error(result?.error || 'register failed');
      this.registeredThreadId.value = threadId;
      this.form.status.value = result.status;
      this.form.error.value = '';
      return true;
    } catch (err) {
      this.form.error.value = this.errorText(err);
      return false;
    } finally {
      this.syncForm(this.controller.heartbeat.value);
    }
  }

  async apply(config: ChatHeartbeatConfig): Promise<void> {
    const normalized = normalizeChatHeartbeatConfig({ ...config, startedAt: null, expiresAt: null, setBy: 'human' });
    this.syncForm(normalized);
    if (!this.registeredThreadId.value) {
      const registered = await this.register(this.backendThreadId());
      this.syncForm(normalized);
      if (!registered) {
        this.controller.setHeartbeat(normalized);
        if (!this.backendThreadId()) this.form.error.value = 'This chat has no backend thread yet — send a message first.';
        return;
      }
    }
    try {
      const result = await this.ipc.invoke('chat-heartbeat:set', { threadId: this.registeredThreadId.value, config: normalized });
      if (!result?.success) throw new Error(result?.error || 'update failed');
      this.form.status.value = result.status;
      // Persist only the deadline that the scheduler confirms.
      this.controller.confirmHeartbeat(result.status);
      this.syncForm(this.controller.heartbeat.value);
      this.form.error.value = '';
    } catch (err) {
      this.form.error.value = this.errorText(err);
      this.syncForm(this.controller.heartbeat.value);
    }
  }

  readonly onStatus = (_event: unknown, value: ChatHeartbeatStatus): void => {
    if (value?.threadId !== this.registeredThreadId.value) return;
    this.form.status.value = value;
    if (!value.enabled && this.controller.heartbeat.value.intervalMinutes !== null) {
      const config = normalizeChatHeartbeatConfig({ ...this.controller.heartbeat.value, intervalMinutes: null, startedAt: null, expiresAt: null });
      this.controller.setHeartbeat(config);
      this.syncForm(config);
    }
  };

  readonly onConfig = (_event: unknown, value: { threadId: string; config: ChatHeartbeatConfig }): void => {
    if (value?.threadId !== this.registeredThreadId.value) return;
    const config = normalizeChatHeartbeatConfig(value.config);
    this.controller.setHeartbeat(config);
    this.syncForm(config);
  };
}
