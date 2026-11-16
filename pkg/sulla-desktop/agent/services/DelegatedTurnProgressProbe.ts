// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Detects whether one delegated graph turn did any work.
 *
 * Counting assistant messages is not enough: context trimming and summary
 * restoration replace `state.messages`, CLI-managed loops run tool calls inside
 * the provider without adding a Sulla assistant message, and a silent wrapper
 * ([SILENT], an empty AGENT_CONTINUE) stores no visible text. Any of those
 * turns used to look "empty" and killed the manager job. A turn made progress
 * when a new assistant message object appeared, or when the graph recorded
 * model/tool activity on this state after the snapshot was taken.
 */
export class DelegatedTurnProgressProbe {
  private readonly priorAssistants: Set<unknown>;
  private readonly priorActivityAt: number;

  constructor(private readonly state: any) {
    this.priorAssistants = new Set(this.assistants());
    this.priorActivityAt = this.activityAt();
  }

  madeProgress(): boolean {
    if (this.activityAt() > this.priorActivityAt) return true;
    return this.assistants().some(message => !this.priorAssistants.has(message));
  }

  private assistants(): unknown[] {
    const messages = Array.isArray(this.state?.messages) ? this.state.messages : [];
    return messages.filter((message: any) => message?.role === 'assistant');
  }

  private activityAt(): number {
    const metadata = this.state?.metadata ?? {};
    return Math.max(this.timestamp(metadata.lastActivityMs), this.timestamp(metadata.lastAgentActivityAt));
  }

  private timestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}
