// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { buildWakeContent } from '../tools/agents/jobDelivery';

import type { AgentJobResult } from '../tools/agents/jobRegistry';

export const COMPLETION_COALESCE_MS = 2_000;
export const COMPLETION_RESULT_LIMIT = 8_000;

export interface PendingCompletion {
  jobId: string;
  results: AgentJobResult[];
  failureReason?: string;
}

interface Inbox {
  entries: PendingCompletion[];
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

export class CompletionInboxStore {
  private readonly inboxes = new Map<string, Inbox>();
  private idleDispatcher?: (channel: string, threadId: string) => void;

  private keyFor(channel: string, threadId: string): string { return `${ channel }|${ threadId }`; }

  registerIdleDispatcher(dispatcher: (channel: string, threadId: string) => void): void { this.idleDispatcher = dispatcher; }

  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key) ?? { entries: [], stopped: false };
    if (!inbox.entries.some(entry => entry.jobId === completion.jobId)) inbox.entries.push(completion);
    this.inboxes.set(key, inbox);
    if (!inbox.stopped && !inbox.timer) {
      inbox.timer = setTimeout(() => {
        inbox.timer = undefined;
        if (!inbox.stopped && inbox.entries.length) this.idleDispatcher?.(channel, threadId);
      }, COMPLETION_COALESCE_MS);
      inbox.timer.unref();
    }
    return true;
  }

  setStopped(channel: string, threadId: string, stopped: boolean): void {
    const inbox = this.inboxes.get(this.keyFor(channel, threadId));
    if (inbox) inbox.stopped = stopped;
  }

  take(channel: string, threadId: string): PendingCompletion[] {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key);
    if (!inbox?.entries.length) return [];
    if (inbox.timer) clearTimeout(inbox.timer);
    const entries = inbox.entries.splice(0);
    inbox.timer = undefined;
    inbox.stopped = false;
    if (!inbox.entries.length) this.inboxes.delete(key);
    return entries;
  }

  format(entries: PendingCompletion[]): string {
    return entries.map(entry => {
      const content = buildWakeContent(entry.jobId, entry.results, entry.failureReason);
      if (content.length <= COMPLETION_RESULT_LIMIT) return content;
      return `${ content.slice(0, COMPLETION_RESULT_LIMIT) }\n\n[Result truncated. Use agents/check_agent_jobs for the full text of ${ entry.jobId }.]`;
    }).join('\n\n==========\n\n');
  }

  clear(): void {
    for (const inbox of this.inboxes.values()) if (inbox.timer) clearTimeout(inbox.timer);
    this.inboxes.clear();
    this.idleDispatcher = undefined;
  }
}

export const completionInboxStore = new CompletionInboxStore();
export const registerCompletionIdleDispatcher = (dispatcher: (channel: string, threadId: string) => void): void => completionInboxStore.registerIdleDispatcher(dispatcher);
export const enqueueAgentCompletion = (channel: string, threadId: string, completion: PendingCompletion): boolean => completionInboxStore.enqueue(channel, threadId, completion);
export const setCompletionInboxStopped = (channel: string, threadId: string, stopped: boolean): void => completionInboxStore.setStopped(channel, threadId, stopped);
export const takeAgentCompletions = (channel: string, threadId: string): PendingCompletion[] => completionInboxStore.take(channel, threadId);
export const formatCompletionBatch = (entries: PendingCompletion[]): string => completionInboxStore.format(entries);

/** Test/process-shutdown hygiene; pending jobs remain durable in agent_jobs. */
export function clearCompletionInboxes(): void { completionInboxStore.clear(); }
