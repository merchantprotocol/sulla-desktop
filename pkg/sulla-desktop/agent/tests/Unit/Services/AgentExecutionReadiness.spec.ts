// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentExecutionReadiness } from '../../../services/AgentExecutionReadiness';
afterEach(() => vi.useRealTimers());
describe('agent execution readiness', () => {
  it('waits beyond one minute of delayed vault startup without failure', async() => {
    vi.useFakeTimers(); let ready = false;
    const gate = new AgentExecutionReadiness(() => Promise.resolve(ready ? undefined : 'Password Vault'));
    const entered = vi.fn(); const run = gate.wait().then(entered);
    await vi.advanceTimersByTimeAsync(65000); expect(entered).not.toHaveBeenCalled();
    ready = true; await vi.advanceTimersByTimeAsync(1000); await run; expect(entered).toHaveBeenCalledTimes(1);
  });
  it('cancels one waiter without cancelling another shared probe', async() => {
    let release!: () => void;
    const inspect = vi.fn(() => new Promise<undefined>(resolve => { release = () => resolve(undefined) }));
    const gate = new AgentExecutionReadiness(inspect); const stop = new AbortController();
    const one = gate.wait(stop.signal); const two = gate.wait(); stop.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    expect(inspect).toHaveBeenCalledTimes(1); release(); await two;
  });
  it('rechecks readiness and cancels all waiters on shutdown; a new lifecycle can reopen it', async() => {
    const inspect = vi.fn(() => Promise.resolve(undefined)); const gate = new AgentExecutionReadiness(inspect);
    await gate.wait(); await gate.wait(); expect(inspect).toHaveBeenCalledTimes(2);
    gate.close(); await expect(gate.wait()).rejects.toMatchObject({ name: 'AbortError' });
    gate.activate(); await gate.wait(); expect(inspect).toHaveBeenCalledTimes(3);
  });
});
