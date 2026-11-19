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

export interface ResultReference { jobId: string; taskIndex: number }
/** Explicit presentation links. These never affect task settlement or question delivery. */
export interface ResultTracking { followUpOf?: ResultReference; decisionIds?: string[] }
export interface ResultActivityRecord extends ResultReference, ResultTracking {
  threadId?: string;
  status:    string;
}
export function resultTracking(value: unknown): ResultTracking {
  const data = value as ResultTracking | undefined;
  const ref = data?.followUpOf;
  return {
    ...(ref && typeof ref.jobId === 'string' && ref.jobId.trim() && Number.isInteger(ref.taskIndex) && ref.taskIndex >= 0 ? { followUpOf: { jobId: ref.jobId, taskIndex: ref.taskIndex } } : {}),
    ...(Array.isArray(data?.decisionIds) ? { decisionIds: [...new Set(data.decisionIds.filter(id => typeof id === 'string' && id.trim()))].slice(0, 20) } : {}),
  };
}

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

export interface AgentResultItem extends ResultTracking {
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
  /** For a blocked or failed agent: what blocks it or what failed, in one sentence. */
  problem?:      string;
  /** Technical details for the card's Details section. */
  model?:        string;
  modelStatus?:  import('../agentState/AgentModelStatus').AgentModelStatusValue;
  runLocation?:  'vm' | 'container';
  workspace?:    string;
  startedAt?:    number;
  endedAt?:      number;
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

const PURPOSES: readonly string[] = Object.keys(PURPOSE_LABEL);
const TONES: readonly string[] = ['ok', 'warn', 'bad', 'info', 'dim'];
const STATUSES: readonly string[] = ['completed', 'blocked', 'error', 'stopped'];

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
    typeof item.report === 'string' && PURPOSES.includes(item.purpose) && TONES.includes(item.tone) && STATUSES.includes(item.status));

  return valid.length === items.length ? { items: valid.map(item => ({ ...item, followUpOf: undefined, decisionIds: undefined, ...resultTracking(item) })) } : undefined;
}

const PROBLEM = /\b(blocker|blocked|blocking|failed|failure|error|cannot|can't|could not|couldn't|unable|needs? (?:a |an |the )?(?:human|owner|approval|sign-off|decision))\b/i;

/**
 * The sentence in an agent's report that says what blocks it or what failed,
 * found in plain code: the last sentence naming a blocker, failure or need.
 * Used for blocked and failed cards, including ones built before the model
 * step could supply it.
 */
/** Sulla's own housekeeping notes appended to a report, e.g. "[Container recovery] Guest workspace retained at …". */
const SYSTEM_NOTE = /^\[(?:container [a-z]+|workspace[^\]]*|sulla[^\]]*)\]\s/i;

/** The agent's words only: cut from the first housekeeping note Sulla appended. */
export function withoutSystemNotes(report: string): string {
  const lines = report.split('\n');
  const at = lines.findIndex(line => SYSTEM_NOTE.test(line.trim()));
  return (at >= 0 ? lines.slice(0, at) : lines).join('\n');
}

/** A housekeeping note is never the problem, whoever recorded it as one. */
export function isSystemNote(text: string | undefined): boolean {
  if (!text) return false;
  const line = text.trim().replace(/^["']/, '');
  return SYSTEM_NOTE.test(line) || /^(?:(?:checkout|guest workspace|workspace) retained\b|(?:workspaceDecisionReason|recoveryWorkspacePath|retainedGuestPaths|removedGuestPaths|cleanupReceipt)["']?\s*:)/i.test(line);
}

export function findProblem(report: string): string | undefined {
  const sentences = withoutSystemNotes(report)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map(part => part.replace(/^[#>*\-\s]+/, '').trim())
    .filter(part => part.length >= 12 && !isSystemNote(part));
  const found = [...sentences].reverse().find(sentence => PROBLEM.test(sentence));
  if (!found) return undefined;
  // The card labels it "Blocked:" itself; the agent's own "[BLOCKED]" tag would repeat it.
  const hit = found.replace(/^\[(?:blocked|failed|error)\]\s*/i, '');

  return hit.length > 260 ? `${ hit.slice(0, 257) }…` : hit;
}

/** The last few lines of a report, where agents usually state where they ended up. */
export function reportTail(report: string, outcome: string, lines = 3): string[] {
  const all = report.split('\n').map(line => line.trim()).filter(Boolean);
  if (all.length <= 1) return [];
  // Sulla's own housekeeping notes come after the agent's words: cut from there.
  const kept = withoutSystemNotes(all.join('\n')).split('\n').filter(Boolean);
  // Closing braces and brackets left by a JSON report say nothing.
  const meaningful = kept.filter(line => /[\p{L}\p{N}]/u.test(line));

  return meaningful.slice(-lines).filter(line => line !== outcome).map(line => (line.length > 220 ? `${ line.slice(0, 217) }…` : line));
}
