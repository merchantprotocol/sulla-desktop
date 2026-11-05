// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The job check-in write this auditor needs (the same record report_progress appends to). */
export interface JobCheckinWriter {
  appendCheckin(threadId: string, input: { step: string; summary: string; filesTouched?: string[]; blockers?: string[] }): Promise<unknown>;
}

/** Records an agent's persistent-container opt-out on its owning job, so the reason is visible in the job record. */
export class PersistentContainerAuditor {
  static readonly STEP = 'persistent container opt-out';

  constructor(private readonly checkins: JobCheckinWriter) {}

  async record(threadId: string | undefined, tool: string, reason: string, labels: Record<string, string>): Promise<boolean> {
    if (!threadId) return false;
    try {
      const recorded = await this.checkins.appendCheckin(threadId, {
        step:    PersistentContainerAuditor.STEP,
        summary: `${ tool } started a persistent container (exempt from the restart-policy refusal). Reason: ${ reason }. Labels: ${ JSON.stringify(labels) }`,
      });
      return !!recorded;
    } catch {
      return false;
    }
  }
}
