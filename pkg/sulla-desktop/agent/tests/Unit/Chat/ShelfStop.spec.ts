// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { SHELF_PAUSE_MESSAGE, ShelfStop } from '@pkg/pages/chat/messages/shelfStop';

function fleet(initial: Record<string, string>) {
  const states = { ...initial };
  let clock = 0;
  const rows = () => Object.entries(states).map(([key, state]) => ({ key, label: key, state, canMessage: true, canStop: true }) as any);
  const message = vi.fn(async() => ({ ok: true }));
  const stop = vi.fn(async(row: any) => { states[row.key] = 'stopped'; return { ok: true } });
  const sleep = vi.fn(async(ms: number) => { clock += ms });
  return { states, deps: { rows, message, stop, sleep, now: () => clock } };
}

describe('stopping a thread for the shelve', () => {
  it('asks every live agent to save and report, and stops nobody who reported', async() => {
    const f = fleet({ a: 'working', b: 'parked', done: 'done' });
    f.deps.sleep.mockImplementation(async() => { f.states.a = 'done'; f.states.b = 'done' });
    const result = await ShelfStop.stopThreadAgents(f.deps);
    expect(f.deps.message).toHaveBeenCalledTimes(2);
    expect(f.deps.message).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }), SHELF_PAUSE_MESSAGE);
    expect(f.deps.stop).not.toHaveBeenCalled();
    expect(result).toEqual({ reported: ['a', 'b'], stopped: [] });
  });

  // risk: shelving left a silent agent running in the background forever
  it('stops agents that do not report within the time limit', async() => {
    const f = fleet({ quiet: 'quiet', ok: 'working' });
    let t = 0;
    const deps = { ...f.deps, now: () => t, sleep: vi.fn(async(ms: number) => { t += ms; f.states.ok = 'done' }) };
    const result = await ShelfStop.stopThreadAgents(deps, 10_000, 3_000);
    expect(deps.stop).toHaveBeenCalledWith(expect.objectContaining({ key: 'quiet' }));
    expect(result).toEqual({ reported: ['ok'], stopped: ['quiet'] });
  });

  it('does nothing when no agent is running', async() => {
    const f = fleet({ done: 'done' });
    expect(await ShelfStop.stopThreadAgents(f.deps)).toEqual({ reported: [], stopped: [] });
    expect(f.deps.message).not.toHaveBeenCalled();
  });

  it('summarises what was stopped for the handoff note', () => {
    expect(ShelfStop.stopSummary({ reported: ['a'], stopped: ['b'] }, true)).toBe([
      'What was stopped for the shelve:',
      '- Saved their work and stopped: a',
      '- Stopped without a final report (did not finish within 2 minutes): b',
      '- The heartbeat was turned off.',
    ].join('\n'));
    expect(ShelfStop.stopSummary({ reported: [], stopped: [] }, false)).toContain('Nothing was running.');
  });
});
