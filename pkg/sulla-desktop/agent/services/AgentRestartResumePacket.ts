// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobCheckin } from '../database/models/AgentJobMessagingModel';
import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

const compact = (value: string | undefined, limit: number): string | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : `${ normalized.slice(0, Math.max(0, limit - 1)) }…`;
};

const list = (values: string[] | undefined, limit = 5): string | undefined => {
  const items = (values ?? []).map(value => compact(value, 180)).filter((value): value is string => Boolean(value));
  if (items.length === 0) return undefined;
  const selected = items.slice(0, limit);
  return `${ selected.join(', ') }${ items.length > selected.length ? ` (+${ items.length - selected.length } more)` : '' }`;
};

/**
 * Deterministic, bounded context for a worker re-entering its durable thread.
 * It contains only already-persisted job metadata and progress, never secrets.
 */
export function agentRestartResumePacket(job: AgentJob, task: AgentJobTask, taskIndex: number, checkin?: AgentJobCheckin | null): string {
  const execution = [
    task.provider,
    task.model,
    task.effort,
  ].map(value => compact(value, 100)).filter(Boolean).join(' · ');
  const lines = [
    '[Runtime restart recovery]',
    `Resume job ${ job.jobId }, task ${ taskIndex } (${ compact(task.label, 180) ?? task.agentId }).`,
    `Agent: ${ task.agentId }.${ execution ? ` Original execution: ${ execution }.` : '' }${ task.runLocation ? ` Run location: ${ task.runLocation }.` : '' }`,
    'The durable workspace and thread state from the original task have been reopened. Continue in that workspace; do not clone a replacement or restart completed work.',
  ];
  if (checkin) {
    lines.push(`Last saved progress (${ new Date(checkin.createdAt).toISOString() }): ${ compact(checkin.step, 120) ?? 'progress' }.`);
    const summary = compact(checkin.summary, 1_200);
    if (summary) lines.push(`Summary: ${ summary }`);
    const files = list(checkin.filesTouched);
    if (files) lines.push(`Files touched: ${ files }`);
    const blockers = list(checkin.blockers);
    if (blockers) lines.push(`Open blockers: ${ blockers }`);
    if (checkin.percent !== undefined) lines.push(`Reported completion: ${ Math.max(0, Math.min(100, checkin.percent)) }%.`);
  } else {
    lines.push('No progress check-in was saved. Inspect the durable workspace and existing thread before changing files.');
  }
  lines.push('Preserve the original contract and call return_result exactly once when finished.');
  return lines.join('\n');
}
