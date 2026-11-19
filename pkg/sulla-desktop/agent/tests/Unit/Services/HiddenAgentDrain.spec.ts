// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentJobLifecycleService } from '../../../services/AgentJobLifecycleService';
import { trackHiddenAgentRun, settleHiddenAgentRuns } from '../../../services/HiddenAgentRuns';

describe('hidden runner shutdown', () => {
  it('waits for the whole runner including asynchronous settlement cleanup', async() => {
    let finish!: () => void;
    let cleanup!: () => void;
    const operation = new Promise<void>(resolve => { finish = resolve }).then(() => new Promise<void>(resolve => { cleanup = resolve }));
    trackHiddenAgentRun(operation);
    let settled = false;
    const drain = settleHiddenAgentRuns().then(() => { settled = true });
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    cleanup(); await drain;
    expect(settled).toBe(true);
  });

  it('does not strand a parked runner whose runtime cancellation already happened', async() => {
    const lifecycle = new AgentJobLifecycleService({ openChildrenForThread: () => Promise.resolve(0) }, () => Promise.resolve(undefined), () => Promise.resolve(undefined));
    const stop = new AbortController();
    stop.abort();
    await lifecycle.waitForWake('one', stop.signal);
    expect(lifecycle.hasLiveWaiter('one')).toBe(false);
  });
});
