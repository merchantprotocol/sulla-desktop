// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { buildWakeContent } from '../tools/agents/jobDelivery';

import type { AgentJobResult, AgentJobTask, AgentJob } from '../tools/agents/jobRegistry';

export interface AgentTerminalNotice {
  status: 'stopped' | 'failed';
  reason: string;
  stoppedBy?: AgentJob['stoppedBy'] | AgentJobTask['stoppedBy'];
}

export const COMPLETION_RESULT_LIMIT = 8_000;

export interface PendingCompletion {
  jobId: string;
  taskIndex: number;
  results: AgentJobResult[];
  failureReason?: string;
  terminal?: AgentTerminalNotice;
  notice?: string;
  dedupeKey?: string;
}

interface Inbox {
  entries: PendingCompletion[];
  stopped: boolean;
}

/** Per-thread, per-task completion queue with no fixed delivery delay. */
export class CompletionInboxStore {
  private readonly inboxes = new Map<string, Inbox>();
  private idleDispatcher?: (channel: string, threadId: string) => void;

  registerIdleDispatcher(dispatcher: (channel: string, threadId: string) => void): void {
    this.idleDispatcher = dispatcher;
  }

  enqueue(channel: string, threadId: string, completion: PendingCompletion): boolean {
    const key = this.keyFor(channel, threadId);
    const inbox = this.inboxes.get(key) ?? { entries: [], stopped: false };
    const entryKey = completion.dedupeKey ?? `completion:${ completion.jobId }:${ completion.taskIndex }`;
    const duplicate = inbox.entries.some(entry => (entry.dedupeKey ?? `completion:${ entry.jobId }:${ entry.taskIndex }`) === entryKey);
    if (!duplicate) inbox.entries.push(completion);
    this.inboxes.set(key, inbox);
    if (!inbox.stopped && !duplicate) this.idleDispatcher?.(channel, threadId);
    return !duplicate;
  }

  move(fromChannel: string, fromThreadId: string, toChannel: string, toThreadId: string, jobId: string, taskIndex?: number): number {
    const sourceKey=this.keyFor(fromChannel,fromThreadId);
    const source=this.inboxes.get(sourceKey);
    if(!source)return 0;
    const selected=source.entries.filter(entry=>entry.jobId===jobId&&(taskIndex===undefined||entry.taskIndex===taskIndex));
    source.entries=source.entries.filter(entry=>!selected.includes(entry));
    if(source.entries.length===0)this.inboxes.delete(sourceKey);
    for(const entry of selected)this.enqueue(toChannel,toThreadId,entry);
    return selected.length;
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

  format(entries: PendingCompletion[]): string {
    return entries.map(entry => {
      const content = entry.notice ?? buildWakeContent(entry.jobId, entry.results, entry.failureReason, entry.terminal);
      if (content.length <= COMPLETION_RESULT_LIMIT) return content;
      return `${ content.slice(0, COMPLETION_RESULT_LIMIT) }\n\n[Result truncated. Use agents/check_agent_jobs for the full text of ${ entry.jobId }.]`;
    }).join('\n\n==========\n\n');
  }

  clear(): void {
    this.inboxes.clear();
    this.idleDispatcher = undefined;
  }

  private keyFor(channel: string, threadId: string): string {
    return `${ channel }|${ threadId }`;
  }
}

export { CompletionInboxStore as AgentCompletionInbox };
export const completionInboxStore = new CompletionInboxStore();
export const registerCompletionIdleDispatcher = (dispatcher: (channel: string, threadId: string) => void): void => completionInboxStore.registerIdleDispatcher(dispatcher);
export const enqueueAgentCompletion = (channel: string, threadId: string, completion: PendingCompletion): boolean => completionInboxStore.enqueue(channel, threadId, completion);
export const notifyAgentCompletionsReady = (channel: string, threadId: string): void => completionInboxStore.notifyReady(channel, threadId);
export const setCompletionInboxStopped = (channel: string, threadId: string, stopped: boolean): void => completionInboxStore.setStopped(channel, threadId, stopped);
export const takeAgentCompletions = (channel: string, threadId: string): PendingCompletion[] => completionInboxStore.take(channel, threadId);
export const formatCompletionBatch = (entries: PendingCompletion[]): string => completionInboxStore.format(entries);

/** Test/process-shutdown hygiene; pending jobs remain durable in agent_jobs. */
export function clearCompletionInboxes(): void { completionInboxStore.clear(); }
