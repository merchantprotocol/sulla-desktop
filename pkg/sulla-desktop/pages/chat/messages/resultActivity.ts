// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentResultItem, ResultReference, ResultActivityRecord } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { DecisionRecord } from '@pkg/shared/decisions';

export interface ResultActivity {
  kind:       'needsYou' | 'working' | 'waiting' | 'blocked' | 'completed' | 'unknown';
  label:      string;
  detail:     string;
  decision?:  DecisionRecord;
  target?:    AgentStateRow;
  targetRef?: ResultReference & { threadId?: string | null };
}
export const resultKey = (ref: ResultReference) => `${ ref.jobId }:${ ref.taskIndex }`;

/** Presentation only. Never infer ownership from labels, PR numbers or later replies. */
export function resultActivity(item: AgentResultItem, input: {
  rows: readonly AgentStateRow[]; items: readonly AgentResultItem[]; decisions: readonly DecisionRecord[]; now?: number; unavailable?: boolean; records?: readonly ResultActivityRecord[]; ownerThreadId?: string;
}): ResultActivity {
  const unknown: ResultActivity = { kind: 'unknown', label: 'Status not confirmed', detail: 'Historical worker report. No linked current action is confirmed; this is not a request for your answer.' };
  if (input.unavailable) return unknown;
  const rows = new Map(input.rows.map(row => [resultKey(row), row]));
  const cards = new Map(input.items.map(card => [resultKey(card), card]));
  const records = new Map((input.records ?? []).map(record => [resultKey(record), record]));
  const origin = resultKey(item);
  cards.set(origin, cards.get(origin) ?? item);
  const all = new Set([...rows.keys(), ...cards.keys(), ...records.keys()]);
  const related = new Set([origin]);
  const parentOf = (key: string) => rows.has(key) ? rows.get(key)?.followUpOf : records.has(key) ? records.get(key)?.followUpOf : cards.get(key)?.followUpOf;
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of all) {
      const parent = parentOf(key);
      if (parent && key !== resultKey(parent) && related.has(resultKey(parent)) && !related.has(key)) { related.add(key); changed = true }
    }
  }
  const threads = new Set<string>();
  const decisionIds = new Set<string>();
  for (const key of related) {
    const source = rows.get(key) ?? records.get(key);
    if (source?.threadId) threads.add(source.threadId);
    for (const id of source?.decisionIds ?? []) decisionIds.add(id);
  }
  const decision = input.decisions.find(record => ['pending', 'deferred'].includes(record.status) && record.expiresAt > (input.now ?? Date.now()) &&
    (threads.has(record.conversationId) || (decisionIds.has(record.id) && record.conversationId === input.ownerThreadId)));
  if (decision) return { kind: 'needsYou', label: 'Needs your answer', detail: decision.title, decision };
  const children = new Set([...related].filter(key => key !== origin).flatMap(key => { const parent = parentOf(key); return parent ? [resultKey(parent)] : [] }));
  const leaves = [...related].filter(key => !children.has(key) && key !== origin);
  const targets = leaves.map(key => rows.get(key)).filter((row): row is AgentStateRow => !!row);
  const statusOf = (key: string) => {
    const state = rows.get(key)?.state;
    const saved = records.get(key)?.status;
    if (saved && ['completed', 'blocked', 'error', 'stopped'].includes(saved)) return saved;
    const reported = cards.get(key)?.status;
    if (reported) return reported;
    return state === 'failed' ? 'error' : state === 'blocked' || state === 'stopped' ? state : undefined;
  };
  const relatedRows = [...related].filter(key => key !== origin).map(key => rows.get(key)).filter((row): row is AgentStateRow => !!row);
  const active = relatedRows.find(row => ['queued', 'working'].includes(row.state)) ?? relatedRows.find(row => row.state === 'parked');
  if (active) {
    if (active.state === 'parked') return { kind: 'waiting', label: /\b(ci|checks?|github|tests?)\b/i.test(active.waitReason ?? '') ? 'Waiting for checks' : 'Sulla waiting', detail: active.waitReason || 'Linked follow-up is waiting. No linked question needs your answer.', target: active };
    return { kind: 'working', label: 'Sulla handling', detail: active.label, target: active };
  }
  if (relatedRows.some(row => ['quiet', 'lost'].includes(row.state))) return unknown;
  const blocked = targets.find(row => ['failed', 'blocked', 'stopped'].includes(row.state)) ?? relatedRows.find(row => row.state === 'blocked' && (row.canMessage || row.canStop));
  if (blocked || leaves.some(key => ['blocked', 'error', 'stopped'].includes(statusOf(key) ?? ''))) {
    return { kind: 'blocked', label: 'Follow-up needs attention', detail: 'A linked follow-up stopped or reported a blocker. No pending human answer is linked.', target: blocked, targetRef: blocked ?? records.get(leaves.find(key => ['blocked', 'error', 'stopped'].includes(statusOf(key) ?? '')) ?? '') };
  }
  if (leaves.length && leaves.every(key => statusOf(key) === 'completed')) {
    return { kind: 'completed', label: 'Follow-up completed', detail: 'Linked follow-up finished. This does not by itself verify the original issue is fixed.', target: targets[0], targetRef: targets[0] ?? records.get(leaves[0]) };
  }
  const current = rows.get(origin);
  if (current && (current.canStop || current.canMessage) && ['queued', 'working', 'parked'].includes(current.state)) {
    return { kind: current.state === 'parked' ? 'waiting' : 'working', label: current.state === 'parked' ? 'Sulla waiting' : 'Sulla handling', detail: current.waitReason || current.label, target: current };
  }
  return unknown;
}
