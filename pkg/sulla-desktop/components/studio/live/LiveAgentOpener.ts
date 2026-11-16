// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

type IpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;
/** Reopens a finished run's own thread from history as a chat tab. */
type HistoryOpener = (threadId: string, title: string) => Promise<void>;

export interface OpenResult { ok: boolean; error?: string }

/**
 * Opens a Live Agents row in a chat tab and always reports the outcome.
 *
 * A live hidden task is promoted to a tab in the main process. That path
 * refuses finished tasks, so a finished run with a thread is reopened from
 * conversation history instead. Every refusal comes back as a visible error.
 */
export class LiveAgentOpener {
  constructor(private readonly invoke: IpcInvoker, private readonly openFromHistory: HistoryOpener) {}

  async open(row: AgentStateRow, rows: readonly AgentStateRow[]): Promise<OpenResult> {
    if (!row.canOpen || !row.threadId) return { ok: false, error: 'This run has no conversation to open.' };
    try {
      if (!row.canStop) {
        await this.openFromHistory(row.threadId, row.label);

        return { ok: true };
      }
      const parentThreadId = this.parentThreadId(row, rows);

      if (!parentThreadId) return { ok: false, error: 'The chat that launched this run is not loaded, so it cannot be opened yet.' };
      const opened = await this.invoke('agents:open-job-in-tab', row.jobId, parentThreadId, row.taskIndex);

      return opened === true ? { ok: true } : { ok: false, error: 'The run could not be opened in a tab. It may have just finished; try again.' };
    } catch (error) {
      return { ok: false, error: `The run could not be opened: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }

  /** The thread that launched this task: its parent task's thread, or the root chat for top-level runs. */
  private parentThreadId(row: AgentStateRow, rows: readonly AgentStateRow[]): string | null {
    if (row.parentJobId === null || row.parentTaskIndex === null) return row.rootThreadId;
    const parent = rows.find(candidate => candidate.jobId === row.parentJobId && candidate.taskIndex === row.parentTaskIndex);

    return parent?.threadId ?? null;
  }
}
