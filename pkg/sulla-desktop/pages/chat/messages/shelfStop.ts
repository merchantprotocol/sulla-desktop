// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentActionResult, AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

export const SHELF_PAUSE_MESSAGE = 'This thread is being shelved. Push all work in progress to its branch, start no new merges, deploys or migrations, report your exact state with return_result, then stop.';
const LIVE: readonly AgentStateRow['state'][] = ['queued', 'working', 'parked', 'quiet', 'blocked'];

export interface ShelfStopDeps {
  /** Current rows for this thread's agents (re-read on every poll). */
  rows:      () => readonly AgentStateRow[];
  message:   (row: AgentStateRow, text: string) => Promise<AgentActionResult>;
  stop:      (row: AgentStateRow) => Promise<AgentActionResult>;
  sleep:     (ms: number) => Promise<void>;
  now:       () => number;
  /** Progress for the panel: "Waiting on 2 agents to report". */
  progress?: (text: string) => void;
}

export interface ShelfStopResult {
  reported: string[];
  stopped:  string[];
}

function isLive(row: AgentStateRow): boolean { return LIVE.includes(row.state) }

/**
 * Ask every live agent to save and report, wait up to `timeoutMs` for them to
 * finish, then stop whatever is still running. Deterministic: no model involved.
 */
async function stopThreadAgents(deps: ShelfStopDeps, timeoutMs = 120_000, pollMs = 3_000): Promise<ShelfStopResult> {
  const targets = deps.rows().filter(isLive);
  if (!targets.length) return { reported: [], stopped: [] };
  const keys = new Set(targets.map(row => row.key));
  await Promise.all(targets.filter(row => row.canMessage).map(row => deps.message(row, SHELF_PAUSE_MESSAGE).catch(() => undefined)));

  const deadline = deps.now() + timeoutMs;
  let live = targets;
  while (deps.now() < deadline) {
    live = deps.rows().filter(row => keys.has(row.key) && isLive(row));
    if (!live.length) break;
    deps.progress?.(`Waiting on ${ live.length } agent${ live.length === 1 ? '' : 's' } to report`);
    await deps.sleep(pollMs);
  }
  live = deps.rows().filter(row => keys.has(row.key) && isLive(row));
  const stopped: string[] = [];
  for (const row of live) {
    if (!row.canStop) continue;
    deps.progress?.(`Stopping ${ row.label }`);
    await deps.stop(row).catch(() => undefined);
    stopped.push(row.label);
  }
  const stoppedKeys = new Set(live.map(row => row.key));
  return { reported: targets.filter(row => !stoppedKeys.has(row.key)).map(row => row.label), stopped };
}

function stopSummary(result: ShelfStopResult, heartbeatWasOn: boolean): string {
  const lines = ['What was stopped for the shelve:'];
  if (result.reported.length) lines.push(`- Saved their work and stopped: ${ result.reported.join(', ') }`);
  if (result.stopped.length) lines.push(`- Stopped without a final report (did not finish within 2 minutes): ${ result.stopped.join(', ') }`);
  if (heartbeatWasOn) lines.push('- The heartbeat was turned off.');
  if (lines.length === 1) lines.push('- Nothing was running.');
  return lines.join('\n');
}

/** Stops a thread's live agents before it is shelved, and says what happened. */
export class ShelfStop {
  static readonly isLive = isLive;
  static readonly stopThreadAgents = stopThreadAgents;
  static readonly stopSummary = stopSummary;
}
