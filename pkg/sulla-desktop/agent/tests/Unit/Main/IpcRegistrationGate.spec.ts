// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcRegistrationGate } from '@pkg/main/ipcRegistrationGate';

describe('IpcRegistrationGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the window until registration finishes, then releases it', async() => {
    // risk: startup ordering — a window opened before handlers exist gets "No handler registered".
    const gate = new IpcRegistrationGate();
    let outcome: unknown;

    void gate.wait(30_000).then((result) => {
      outcome = result;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome).toBeUndefined();

    gate.markRegistered();
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome).toEqual({ state: 'registered' });
    expect(gate.isRegistered).toBe(true);
  });

  it('answers immediately once registered, without waiting on the timer', async() => {
    // risk: startup latency — later waits (second window, retries) must not pay the timeout.
    const gate = new IpcRegistrationGate();

    gate.markRegistered();

    await expect(gate.wait(30_000)).resolves.toEqual({ state: 'registered' });
  });

  it('times out instead of leaving the app windowless when registration hangs', async() => {
    // risk: availability — a stuck onMainProxyLoad must never keep every window closed.
    const gate = new IpcRegistrationGate();
    const pending = gate.wait(30_000);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toEqual({ state: 'timed-out' });
    expect(gate.isRegistered).toBe(false);
  });

  it('stops waiting as soon as registration fails, and keeps the first outcome', async() => {
    // risk: availability — a thrown registration must not add the full timeout to startup.
    const gate = new IpcRegistrationGate();
    const pending = gate.wait(30_000);
    const error = new Error('vault import failed');

    gate.markFailed(error);
    gate.markRegistered();

    await expect(pending).resolves.toEqual({ state: 'failed', error });
    await expect(gate.wait(30_000)).resolves.toEqual({ state: 'failed', error });
    expect(gate.isRegistered).toBe(false);
  });
});
