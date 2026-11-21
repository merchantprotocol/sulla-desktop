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

  private static readonly responses = new Map<string, AgentModelStatusValue[]>();
  static recordResponse(threadId: string, models: AgentModelStatusValue[]): void {
    const previous = this.responses.get(threadId);
    if (previous?.length === models.length && previous.every((item, i) => item.model === models[i].model && item.provider === models[i].provider && item.effort === models[i].effort && item.modelEvidence === models[i].modelEvidence && JSON.stringify(item.fallbackFrom) === JSON.stringify(models[i].fallbackFrom))) return;
    this.responses.delete(threadId);
    this.responses.set(threadId, models);
    if (this.responses.size > 1024) this.responses.delete(this.responses.keys().next().value!);
    for (const listener of this.listeners) listener();
  }
  static responsesFor(threadId?: string | null): AgentModelStatusValue[] | undefined {
    return threadId ? this.responses.get(threadId) : undefined;
  }

  static get(threadId?: string | null): AgentModelStatusValue | undefined { return threadId ? this.statuses.get(threadId) : undefined }
}
