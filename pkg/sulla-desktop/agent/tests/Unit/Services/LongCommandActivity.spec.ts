// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { AgentTaskActivityProjector } from '@pkg/agent/app/Services/AgentTaskActivityProjector';
import { RunToolTracker } from '@pkg/agent/services/RunToolTracker';

const MIN = 60_000;
const job: any = { jobId: 'seed', createdAt: 0, tasks: [] };
const task: any = { agentId: 'codex-sol-worker', label: 'Lane 0 seeder', prompt: '', status: 'running', startedAt: 0 };

function projectorAt(now: number, tools: RunToolTracker, lastActivityAt: number) {
  return new AgentTaskActivityProjector({ lastActivityAt: () => lastActivityAt, toolInFlight: key => tools.inFlight(key, now) }, () => now, 5 * MIN);
}

describe('an agent busy in one long command', () => {
  // risk: a worker running a 7-minute seeding script produced no output, so the
  // chat said "No progress · it may have stopped" while it was working
  it('stays working while a command is still running', () => {
    const tools = new RunToolTracker(() => 1 * MIN);
    tools.started({ activityKeys: ['seed#0'] }, 'call-1', 'Bash');

    const view = projectorAt(8 * MIN, tools, 1 * MIN).project(job, task, 0, null);

    expect(view.state).toBe('working');
    expect(tools.inFlight('seed#0', 8 * MIN)).toEqual({ name: 'Bash', startedAt: 1 * MIN });
  });

  it('still flags a command that has run past the long-command limit', () => {
    const tools = new RunToolTracker(() => 1 * MIN);
    tools.started({ activityKeys: ['seed#0'] }, 'call-1', 'Bash');

    expect(projectorAt(32 * MIN, tools, 1 * MIN).project(job, task, 0, null).state).toBe('quiet');
  });

  it('goes quiet again once the command has finished and nothing else happens', () => {
    const tools = new RunToolTracker(() => 1 * MIN);
    tools.started({ activityKeys: ['seed#0'] }, 'call-1', 'Bash');
    tools.finished({ activityKeys: ['seed#0'] }, 'call-1');

    expect(tools.inFlight('seed#0', 8 * MIN)).toBeUndefined();
    expect(projectorAt(8 * MIN, tools, 1 * MIN).project(job, task, 0, null).state).toBe('quiet');
  });

  it('forgets every in-flight command when the run process exits', () => {
    const tools = new RunToolTracker(() => 1 * MIN);
    tools.started({ activityKeys: ['seed#0', 'manager#0'] }, 'call-1', 'Bash');
    tools.clear({ activityKeys: ['seed#0', 'manager#0'] });

    expect(tools.inFlight('seed#0', 2 * MIN)).toBeUndefined();
    expect(tools.inFlight('manager#0', 2 * MIN)).toBeUndefined();
  });
});
