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

const inboxes = new Map<string, Inbox>();
let idleDispatcher: ((channel: string, threadId: string) => void) | undefined;

const keyFor = (channel: string, threadId: string) => `${ channel }|${ threadId }`;

export function registerCompletionIdleDispatcher(dispatcher: (channel: string, threadId: string) => void): void {
  idleDispatcher = dispatcher;
}

export function enqueueAgentCompletion(channel: string, threadId: string, completion: PendingCompletion): boolean {
  const key = keyFor(channel, threadId);
  const inbox = inboxes.get(key) ?? { entries: [], stopped: false };
  if (!inbox.entries.some(entry => entry.jobId === completion.jobId)) inbox.entries.push(completion);
  inboxes.set(key, inbox);
  if (!inbox.stopped && !inbox.timer) {
    inbox.timer = setTimeout(() => {
      inbox.timer = undefined;
      if (!inbox.stopped && inbox.entries.length) idleDispatcher?.(channel, threadId);
    }, COMPLETION_COALESCE_MS);
    inbox.timer.unref();
  }
  return true;
}

export function setCompletionInboxStopped(channel: string, threadId: string, stopped: boolean): void {
  const inbox = inboxes.get(keyFor(channel, threadId));
  if (inbox) inbox.stopped = stopped;
}

export function takeAgentCompletions(channel: string, threadId: string): PendingCompletion[] {
  const key = keyFor(channel, threadId);
  const inbox = inboxes.get(key);
  if (!inbox?.entries.length) return [];
  if (inbox.timer) clearTimeout(inbox.timer);
  const entries = inbox.entries.splice(0);
  inbox.timer = undefined;
  inbox.stopped = false;
  if (!inbox.entries.length) inboxes.delete(key);
  return entries;
}

export function formatCompletionBatch(entries: PendingCompletion[]): string {
  return entries.map(entry => {
    const content = buildWakeContent(entry.jobId, entry.results, entry.failureReason);
    if (content.length <= COMPLETION_RESULT_LIMIT) return content;
    return `${ content.slice(0, COMPLETION_RESULT_LIMIT) }\n\n[Result truncated. Use agents/check_agent_jobs for the full text of ${ entry.jobId }.]`;
  }).join('\n\n==========\n\n');
}
