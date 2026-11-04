// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ConversationTerminalReader { isTerminalDelegatedThread(threadId: string): Promise<boolean>; }
export interface ConversationContainerRecord {
  lifecycle: { close(reason: string, source: string): Promise<void> };
  idleTimer: ReturnType<typeof setTimeout>;
}

/** Decides whether a completed conversation turn is re-armed or closed. */
export class ConversationContainerSettlementService {
  constructor(private readonly terminalThreads: ConversationTerminalReader) {}

  async settle(
    threadId: string,
    record: ConversationContainerRecord,
    clear: (timer: ReturnType<typeof setTimeout>) => void,
    remove: () => void,
    rearm: () => ReturnType<typeof setTimeout>,
  ): Promise<'closed' | 'rearmed'> {
    clear(record.idleTimer);
    if (await this.terminalThreads.isTerminalDelegatedThread(threadId)) {
      remove();
      await record.lifecycle.close('agent-job-terminal', 'BackendGraphWebSocketService.settleConversationContainer');
      return 'closed';
    }
    record.idleTimer = rearm();
    return 'rearmed';
  }
}
