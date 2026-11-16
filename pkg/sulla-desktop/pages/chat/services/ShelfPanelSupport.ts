// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { useChatController } from '../controller/useChatController';
import type { ShelfEntry } from '../messages/shelfNote';

type ChatController = ReturnType<typeof useChatController>;

/** The shelf panel's calls to Sulla Files, and its wait for Sulla's handoff reply. */
export class ShelfPanelSupport {
  static readonly REPLY_TIMEOUT_MS = 5 * 60_000;

  constructor(private readonly controller: ChatController) {}

  /** One shelf IPC call; a failed one throws with Sulla Files' error. */
  static async ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
    const result = await ipcRenderer.invoke(channel as any, ...args) as { ok: boolean; value?: T; error?: string };
    if (!result?.ok) throw new Error(result?.error || 'Sulla Files did not respond');
    return result.value as T;
  }

  static sleep(ms: number): Promise<void> { return new Promise<void>(resolve => setTimeout(resolve, ms)) }

  /** "shelved Nov 15 12:47 PM", or nothing for a note without a valid date. */
  static shelvedWhen(entry: ShelfEntry): string {
    const d = new Date(entry.meta.shelvedAt);
    return Number.isNaN(d.getTime()) ? '' : `shelved ${ d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } ${ d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }`;
  }

  /** Sulla's first finished reply sent after `after`, within five minutes. */
  async waitForReply(after: number): Promise<string> {
    const deadline = Date.now() + ShelfPanelSupport.REPLY_TIMEOUT_MS;
    await ShelfPanelSupport.sleep(500);
    while (Date.now() < deadline) {
      if (!this.controller.isRunning.value) {
        const reply = [...this.controller.messages.value].reverse().find(msg => msg.kind === 'sulla' && msg.createdAt >= after);
        if (reply?.kind === 'sulla' && reply.text.trim()) return reply.text;
      }
      await ShelfPanelSupport.sleep(1_000);
    }
    throw new Error('Sulla did not write the handoff note within 5 minutes.');
  }
}
