// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { buildWakeContent } from '../tools/agents/jobDelivery';

import type { AgentJobResult } from '../tools/agents/jobRegistry';

export const COMPLETION_RESULT_LIMIT = 8_000;

export interface PendingCompletion {
  jobId: string;
  taskIndex: number;
  results: AgentJobResult[];
  failureReason?: string;
}

interface Inbox {
  entries: PendingCompletion[];
  stopped: boolean;
}

/**
 * Per-thread completion queue. A task, not a job, is the delivery identity:
 * sibling contracts can therefore become ready and wake their parent
 * independently without allowing a retry to enqueue the same contract twice.
 */
export class AgentCompletionInbox {
  private readonly inboxes = new Map<string, Inbox>();
  private idleDispatcher?: (channel: string, threadId: string) => void;

  registerIdleDispatcher(dispatcher: (channel: string, threadId: string) => void): void {
    this.idleDispatcher = dispatcher;
  }

  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key) ?? { entries: [], stopped: false };
    const duplicate = inbox.entries.some(entry => entry.jobId === completion.jobId && entry.taskIndex === completion.taskIndex);
    if (!duplicate) inbox.entries.push(completion);
    this.inboxes.set(key, inbox);
    if (!inbox.stopped && !duplicate) this.idleDispatcher?.(channel, threadId);
    return !duplicate;
  }

  notifyReady(channel: string, threadId: string): void {
    const inbox = this.inboxes.get(this.keyFor(channel, threadId));
    if (!inbox?.stopped && inbox?.entries.length) this.idleDispatcher?.(channel, threadId);
  }

  setStopped(channel: string, threadId: string, stopped: boolean): void {
    const inbox = this.inboxes.get(this.keyFor(channel, threadId));
    if (inbox) inbox.stopped = stopped;
  }

  take(channel: string, threadId: string): PendingCompletion[] {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key);
    if (!inbox?.entries.length) return [];
    const entries = inbox.entries.splice(0);
    inbox.stopped = false;
    this.inboxes.delete(key);
    return entries;
  }

  clear(): void {
    this.inboxes.clear();
    this.idleDispatcher = undefined;
  }

  private keyFor(channel: string, threadId: string): string {
    return `${ channel }|${ threadId }`;
  }
}

const completionInbox = new AgentCompletionInbox();

export function registerCompletionIdleDispatcher(dispatcher: (channel: string, threadId: string) => void): void {
  completionInbox.registerIdleDispatcher(dispatcher);
}

export function enqueueAgentCompletion(channel: string, threadId: string, completion: PendingCompletion): boolean {
  return completionInbox.enqueue(channel, threadId, completion);
}

export function notifyAgentCompletionsReady(channel: string, threadId: string): void {
  completionInbox.notifyReady(channel, threadId);
}

export function setCompletionInboxStopped(channel: string, threadId: string, stopped: boolean): void {
  completionInbox.setStopped(channel, threadId, stopped);
}

export function takeAgentCompletions(channel: string, threadId: string): PendingCompletion[] {
  return completionInbox.take(channel, threadId);
}

export function formatCompletionBatch(entries: PendingCompletion[]): string {
  return entries.map(entry => {
    const content = buildWakeContent(entry.jobId, entry.results, entry.failureReason);
    if (content.length <= COMPLETION_RESULT_LIMIT) return content;
    return `${ content.slice(0, COMPLETION_RESULT_LIMIT) }\n\n[Result truncated. Use agents/check_agent_jobs for the full text of ${ entry.jobId }.]`;
  }).join('\n\n==========\n\n');
}

/** Test/process-shutdown hygiene; pending jobs remain durable in agent_jobs. */
export function clearCompletionInboxes(): void {
  completionInbox.clear();
}
