// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ReturnResultWorker } from '../../../tools/agents/return_result';
import { TestDatabase } from '../../Support/TestDatabase';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

class ReturnResultHarness extends ReturnResultWorker {
  runHarness(threadId: string, input: unknown) {
    this.setState({ metadata: { threadId } } as any);

    return this._validatedCall(input);
  }
}

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('dormant parked worker that returns during a timer wake (real Postgres)', () => {
  const database = new TestDatabase();
  let registry: typeof import('../../../tools/agents/jobRegistry');
  let lifecycle: typeof import('../../../services/AgentJobLifecycleService');
  let inbox: typeof import('../../../services/AgentCompletionInbox');

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    const { postgresClient } = await import('../../../database/PostgresClient');

    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    await database.applyMigrations();
    registry = await import('../../../tools/agents/jobRegistry');
    lifecycle = await import('../../../services/AgentJobLifecycleService');
    inbox = await import('../../../services/AgentCompletionInbox');
  }, 60_000);
  afterAll(async() => database.dispose());

  it('closes the job and hands the result to the parent instead of leaving it parked with the return recorded', async() => {
    // risk (2026-11-15 merge train, Fable/Opus fix, attribution override): the timer
    // woke a dormant worker, it called return_result, and the wake turn's end
    // re-parked it; the parent never got the result and the job stayed parked.
    const job = await registry.createJob([
      { agentId: 'worker', label: 'Merge train', prompt: 'merge, then wait for staging', status: 'running', threadId: 'dormant-merge-thread' },
    ], 'sulla-desktop', 'orchestrator-thread');

    await registry.parkJobTask(job.jobId, 0, 0);
    await lifecycle.agentJobLifecycle.beginWakeTurn(job.jobId, 0);
    const returned = await new ReturnResultHarness().runHarness('dormant-merge-thread', { result: { summary: 'all 11 PRs merged; staging deployed' } });

    expect(returned.responseString).toContain('returned');
    expect(returned.successBoolean).toBe(true);
    await lifecycle.agentJobLifecycle.endDormantWakeTurn(job.jobId, 0);

    const settled = await registry.getJob(job.jobId);

    expect(settled?.status).toBe('completed');
    expect(settled?.tasks[0]).toMatchObject({ status: 'completed', completion: expect.objectContaining({ output: expect.stringContaining('staging deployed') }) });
    expect(inbox.takeAgentCompletions('sulla-desktop', 'orchestrator-thread').map(entry => entry.jobId)).toContain(job.jobId);
  });

  it('settles a return stranded before this fix on the next app start', async() => {
    // risk: the jobs already stuck as parked + returnedAt never reach their parent
    const job = await registry.createJob([
      { agentId: 'worker', label: 'Stranded', prompt: 'p', status: 'running', threadId: 'stranded-thread' },
    ], 'sulla-desktop', 'orchestrator-thread-2');

    await registry.recordTaskReturn(job.jobId, 0, { result: { output: 'done long ago' }, status: 'completed' });
    await registry.parkJobTask(job.jobId, 0, 0);
    expect((await registry.getJob(job.jobId))?.status).toBe('parked');

    expect(await lifecycle.returnedTaskSettlement.settleStranded()).toBe(1);
    expect((await registry.getJob(job.jobId))?.status).toBe('completed');
    expect(await lifecycle.returnedTaskSettlement.settleStranded()).toBe(0);
  });
});
