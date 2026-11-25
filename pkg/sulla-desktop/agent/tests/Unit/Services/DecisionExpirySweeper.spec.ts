// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { DecisionExpirySweeper } from '../../../services/DecisionExpirySweeper';

class ManualTimer {
  intervalMs?: number;
  cancelled = false;
  private tick?: () => void;
  every(intervalMs: number, tick: () => void): () => void {
    this.intervalMs = intervalMs;
    this.tick = tick;
    return () => { this.cancelled = true; this.tick = undefined };
  }
  fire(): void { this.tick?.() }
}

describe('DecisionExpirySweeper', () => {
  it('sweeps once at startup, again on each tick, and stops when disposed', async() => {
    // risk: fail closed — a durable approval must expire after a restart even when nobody opens Decide.
    const decisions = { reconcileExpired: vi.fn(async() => undefined) };
    const timer = new ManualTimer();
    const sweeper = new DecisionExpirySweeper(decisions, timer);

    sweeper.start();
    sweeper.start();
    await vi.waitFor(() => expect(decisions.reconcileExpired).toHaveBeenCalledTimes(1));
    expect(timer.intervalMs).toBe(5 * 60_000);

    timer.fire();
    await vi.waitFor(() => expect(decisions.reconcileExpired).toHaveBeenCalledTimes(2));

    sweeper.dispose();
    expect(timer.cancelled).toBe(true);
    timer.fire();
    expect(decisions.reconcileExpired).toHaveBeenCalledTimes(2);
  });

  it('reports a failed sweep and tries again on the next tick', async() => {
    // risk: availability — the database may not be ready at startup; one failed pass must not end expiry for the session.
    const decisions = { reconcileExpired: vi.fn(async() => undefined).mockRejectedValueOnce(new Error('database not ready')) };
    const timer = new ManualTimer();
    const failures: string[] = [];
    const sweeper = new DecisionExpirySweeper(decisions, timer, message => failures.push(message));

    sweeper.start();
    await vi.waitFor(() => expect(failures).toEqual(['Expiring overdue decisions failed:']));
    timer.fire();
    await vi.waitFor(() => expect(decisions.reconcileExpired).toHaveBeenCalledTimes(2));
    expect(failures).toHaveLength(1);
    sweeper.dispose();
  });
});
