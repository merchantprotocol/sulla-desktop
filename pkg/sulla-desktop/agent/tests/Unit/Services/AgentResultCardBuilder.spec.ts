// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { AgentResultCardBuilder } from '@pkg/agent/services/agentResults/AgentResultCardBuilder';

const report = 'All 10 BE + FE #1339 merged. #4320 -> 70c870f, #4315 -> ea0d945. Staging CD (tip of main) on ea0d945: success.';
const job: any = {
  jobId:     'agent-job-1',
  createdAt: 1_000,
  tasks:     [
    { agentId: 'codex-sol-worker', label: 'Merge train', threadId: 'spawn-merge', startedAt: 1_000, finishedAt: 1_000 + 2 * 3_600_000 },
  ],
};
const result: any = { label: 'Merge train', status: 'completed', output: report, threadId: 'spawn-merge' };
const reply = (body: unknown) => vi.fn(() => Promise.resolve(JSON.stringify(body)));

describe('the finished-agent card', () => {
  it('shows a merge as merges and environments, with only what the report says', async() => {
    const model = reply({
      items: [{
        index:        0,
        purpose:      'merge',
        verdict:      'Merged',
        tone:         'ok',
        outcome:      'All 11 PRs are on main and staging deployed ea0d945.',
        merges:       [{ pr: '#4320', sha: '70c870f' }, { pr: '#4315', sha: 'ea0d945' }],
        environments: [{ name: 'Staging', state: 'deployed' }, { name: 'Production', state: 'held' }],
        next:         { label: 'Run staging QA', prompt: 'Run staging QA for the merged PRs.' },
      }],
    });

    const [item] = (await new AgentResultCardBuilder(model).build(job, [result])).items;

    expect(item).toMatchObject({ purpose: 'merge', verdict: 'Merged', tone: 'ok', agentId: 'codex-sol-worker', threadId: 'spawn-merge', durationMs: 7_200_000 });
    expect(item.merges?.map(merge => merge.pr)).toEqual(['#4320', '#4315']);
    // risk: a production row the report never mentioned reads as a real release state
    expect(item.environments?.map(env => env.name)).toEqual(['Staging']);
    expect(item.report).toBe(report);
  });

  // risk: a failed agent shown with a green "Done" chip because the model was upbeat
  it('never lets the model turn a failed or blocked agent green or offer it a next step', async() => {
    const model = reply({ items: [{ index: 0, purpose: 'fix', verdict: 'Done', tone: 'ok', outcome: 'Tests could not run.', next: { label: 'Merge it', prompt: 'Merge.' } }] });

    const [item] = (await new AgentResultCardBuilder(model).build(job, [{ ...result, status: 'error' }])).items;

    expect(item).toMatchObject({ verdict: 'Failed', tone: 'bad', purpose: 'fix', outcome: 'Tests could not run.' });
    expect(item.next).toBeUndefined();
  });

  it('falls back to a plain card when the model fails, answers nonsense, or is too slow', async() => {
    const failing = vi.fn(() => Promise.reject(new Error('no provider')));
    const nonsense = vi.fn(() => Promise.resolve('I cannot help with that.'));
    const slow = vi.fn((_s: string, _u: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));

    for (const model of [failing, nonsense, slow]) {
      const [item] = (await new AgentResultCardBuilder(model, 20).build(job, [result])).items;
      expect(item).toMatchObject({ purpose: 'other', verdict: 'Done', tone: 'ok', outcome: 'All 10 BE + FE #1339 merged.' });
      expect(item.links).toEqual([]);
    }
  });

  it('builds a card without any model at all', async() => {
    const [item] = (await new AgentResultCardBuilder(undefined).build(job, [{ ...result, status: 'blocked', output: 'Need the QA account password.' }])).items;

    expect(item).toMatchObject({ verdict: 'Blocked', tone: 'warn', outcome: 'Need the QA account password.' });
  });
});
