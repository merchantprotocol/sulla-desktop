// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { GuestWorkspaceCleanupInspector, RETAINED_WORKSPACE_REASON } from '../../../services/GuestWorkspaceCleanupInspector';

const AGENTS = '/mnt/data/sulla/runtime/agents';
const CONVERSATIONS = '/mnt/data/sulla/runtime/conversations';

function inspector(guestState = 'empty') {
  const run = vi.fn(async(_args: string[]) => guestState);
  return { run, instance: new GuestWorkspaceCleanupInspector({ ephemeralRoot: AGENTS, persistentRoot: CONVERSATIONS, run }) };
}

describe('container workspace cleanup decision', () => {
  it('keeps a persistent conversation workspace without flagging it as a recovery workspace', async() => {
    // risk: "[Container recovery] ... could not be inspected safely" on every persistent job
    const { instance, run } = inspector();
    const decision = await instance.inspect(`${ CONVERSATIONS }/0123abcd/workspace`);

    expect(decision).toEqual({ remove: false, persistent: true, reason: 'persistent conversation workspace kept for the next turn' });
    expect(run).not.toHaveBeenCalled();
  });

  it('removes an empty job workspace', async() => {
    // risk: an empty scratch directory left behind on every job
    const { instance, run } = inspector('empty');
    const decision = await instance.inspect(`${ AGENTS }/job-1-0-abcdEFGH`);

    expect(decision.remove).toBe(true);
    expect(run.mock.calls[0][0]).toContain(`${ AGENTS }/job-1-0-abcdEFGH`);
  });

  it('treats an already-removed job workspace as removable', async() => {
    // risk: a missing workspace reported as a retained recovery path
    expect((await inspector('missing').instance.inspect(`${ AGENTS }/gone`)).remove).toBe(true);
  });

  it('retains a job workspace that holds files, with the reason', async() => {
    // risk: deleting unpublished worker output
    const decision = await inspector('content').instance.inspect(`${ AGENTS }/repo-branch-job-1-0-abcdEFGH`);
    expect(decision).toEqual({ remove: false, reason: RETAINED_WORKSPACE_REASON });
  });

  it('refuses a workspace outside both runtime roots', async() => {
    // risk: cleanup reaching outside the bounded guest runtime
    const { instance, run } = inspector();
    await expect(instance.inspect('/mnt/data/sulla/runtime/agents-evil/x')).rejects.toThrow('outside the agent workspace roots');
    await expect(instance.inspect(`${ AGENTS }/../conversations`)).rejects.toThrow('outside the agent workspace roots');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses to guess on an unexpected guest answer', async() => {
    // risk: removing a workspace on garbage output
    await expect(inspector('').instance.inspect(`${ AGENTS }/job`)).rejects.toThrow('Unexpected guest workspace inspection result');
  });
});
