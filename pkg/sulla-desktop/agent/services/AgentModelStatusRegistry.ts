// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentModelStatusValue } from '../../shared/agentState/AgentModelStatus';

/** Read-only presentation telemetry, never used for routing or recovery decisions. */
export class AgentModelStatusRegistry {
  private static readonly listeners = new Set<() => void>();
  static onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private static readonly statuses = new Map<string, AgentModelStatusValue>();
  static record(threadId: string, value: AgentModelStatusValue): void {
    const previous = this.statuses.get(threadId);
    if (previous?.model === value.model && previous?.provider === value.provider && previous?.effort === value.effort && previous?.source === value.source && previous?.mapping === value.mapping) return;
    this.statuses.delete(threadId);
    this.statuses.set(threadId, value);
    for (const listener of this.listeners) listener();
    if (this.statuses.size > 1024) this.statuses.delete(this.statuses.keys().next().value!);
  }

  static get(threadId?: string | null): AgentModelStatusValue | undefined { return threadId ? this.statuses.get(threadId) : undefined }
}
