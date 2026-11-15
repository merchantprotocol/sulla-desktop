// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The finished-agent result card shared by the agent process (which builds it
 * when delegated work settles) and the chat renderer (which draws it). Types
 * only, plus the pure validation both sides use on untrusted card data.
 */

export type AgentResultPurpose = 'merge' | 'qa' | 'review' | 'fix' | 'other';
export type AgentResultTone = 'ok' | 'warn' | 'bad' | 'info' | 'dim';
export type AgentResultStatus = 'completed' | 'blocked' | 'error' | 'stopped';

export interface AgentResultMerge { pr: string; title?: string; sha?: string }
export interface AgentResultEnvironment { name: string; detail?: string; state: 'deployed' | 'failed' | 'pending' | 'held' }
export interface AgentResultCheck { name: string; detail?: string; passed: boolean }
export interface AgentResultFinding { severity: 'blocking' | 'major' | 'minor'; title: string; detail?: string; file?: string }
export interface AgentResultChange {
  pr?:           string;
  branch?:       string;
  filesChanged?: number;
  added?:        number;
  removed?:      number;
  files?:        string[];
  tests?:        string;
  ci?:           string;
}
export interface AgentResultLink { label: string; url: string }

export interface AgentResultItem {
  jobId:         string;
  taskIndex:     number;
  label:         string;
  agentId?:      string;
  /** The agent's own conversation, for opening it from the card. */
  threadId?:     string;
  durationMs?:   number;
  status:        AgentResultStatus;
  purpose:       AgentResultPurpose;
  /** Short chip text, e.g. "Merged", "2 failed", "Changes needed". */
  verdict:       string;
  tone:          AgentResultTone;
  /** One plain sentence saying what happened. */
  outcome:       string;
  merges?:       AgentResultMerge[];
  environments?: AgentResultEnvironment[];
  tally?:        { passed?: number; failed?: number; skipped?: number };
  checks?:       AgentResultCheck[];
  findings?:     AgentResultFinding[];
  change?:       AgentResultChange;
  links?:        AgentResultLink[];
  /** A suggested next step, drafted into the composer for the user to send. */
  next?:         { label: string; prompt: string };
  /** The agent's full report, unchanged. */
  report:        string;
}

export interface AgentResultCardData {
  items: AgentResultItem[];
}

export const PURPOSE_LABEL: Record<AgentResultPurpose, string> = {
  merge:  'Merge and deploy',
  qa:     'QA run',
  review: 'Review',
  fix:    'Fix',
  other:  'Finished',
};

const PURPOSE_SET = new Set(Object.keys(PURPOSE_LABEL));
const TONE_SET = new Set(['ok', 'warn', 'bad', 'info', 'dim']);
const STATUS_SET = new Set(['completed', 'blocked', 'error', 'stopped']);

/**
 * Accept card data from a message only when each item has the fields the
 * card needs to draw; anything else falls back to the plain text notice.
 */
export function readAgentResultCard(value: unknown): AgentResultCardData | undefined {
  const items = (value as AgentResultCardData | undefined)?.items;
  if (!Array.isArray(items) || !items.length) return undefined;
  const valid = items.filter((item): item is AgentResultItem => !!item && typeof item === 'object' &&
    typeof item.jobId === 'string' && Number.isInteger(item.taskIndex) &&
    typeof item.label === 'string' && typeof item.verdict === 'string' && typeof item.outcome === 'string' &&
    typeof item.report === 'string' && PURPOSE_SET.has(item.purpose) && TONE_SET.has(item.tone) && STATUS_SET.has(item.status));

  return valid.length === items.length ? { items: valid } : undefined;
}
