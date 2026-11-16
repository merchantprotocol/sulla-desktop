// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// First-run vault creation must always end with the vault created and unlocked
// after the First Run password, however late the vault service or Cloud answers.
// Regression for the iMac first run (2026-11-15) where the vault stayed locked,
// pending sign-ins never flushed and Files never got its mount capability.
// Synthetic data only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopEnrollmentCoordinator, type DesktopEnrollmentDependencies } from '../../../../main/cloud/enrollment/DesktopEnrollmentCoordinator';
import {
  FirstRunVaultCreation,
  type ContainerVaultStatus,
  type FirstRunVaultCreationDependencies,
  type VaultCreationDisposition,
} from '../../../../main/firstRun/FirstRunVaultCreation';

const TIMING = { pollMs: 5_000, stepTimeoutMs: 30_000, retryInitialMs: 2_000, retryMaxMs: 60_000, staleLockWindowMs: 120_000 };

/** A container vault that can be down, empty (setup required), locked or unlocked. */
class FakeContainerVault {
  answering = true;
  setupRequired = true;
  unlocked = false;
  created = 0;

  async status(): Promise<ContainerVaultStatus> {
    if (!this.answering) throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
    return { unlocked: this.unlocked, setupRequired: this.setupRequired };
  }

  create(): void {
    this.created += 1;
    this.unlocked = true;
    this.setupRequired = false;
  }
}

class Harness {
  readonly vault = new FakeContainerVault();
  readonly traces: string[] = [];
  readonly errors: string[] = [];
  keyHeld = true;
  hold = false;
  lifecycleUnlocked = false;
  published = 0;
  gate: () => Promise<VaultCreationDisposition> = async() => 'create';
  readonly creation: FirstRunVaultCreation;

  constructor() {
    const deps: FirstRunVaultCreationDependencies = {
      holdUntilWizardCloses: () => this.hold,
      hasPendingKey:         () => this.keyHeld,
      containerStatus:       () => this.vault.status(),
      lifecycleUnlocked:     () => this.lifecycleUnlocked,
      enrollmentGate:        () => this.gate(),
      enrollmentComplete:    async() => 'waiting_for_approver',
      createOrRewrap:        async() => {
        this.vault.create();
        this.keyHeld = false;
        this.lifecycleUnlocked = true; // flushAccountPasswordWrap publishes the unlock
        this.published += 1;
      },
      publishUnlocked: async() => { this.lifecycleUnlocked = true; this.published += 1 },
      zeroKey:         () => { this.keyHeld = false },
      trace:           message => { this.traces.push(message) },
      logError:        message => { this.errors.push(message) },
    };
    this.creation = new FirstRunVaultCreation(deps, TIMING);
  }
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  h = new Harness();
});

afterEach(() => {
  h.creation.stop();
  vi.useRealTimers();
});

describe('FirstRunVaultCreation', () => {
  it('first-run sign-in creates and unlocks the vault as soon as the container answers, without waiting on the lifecycle vault service', async() => {
    // risk: irreversible — a held Cloud key that never becomes a vault strands every pending sign-in
    await h.creation.poke();

    expect(h.vault.created).toBe(1);
    expect(h.vault.unlocked).toBe(true);
    expect(h.lifecycleUnlocked).toBe(true);
    expect(h.keyHeld).toBe(false);
    expect(h.traces).toContain('vault created and unlocked');
  });

  it('a missed readiness event still creates the vault: the safety-net poll retries until the container answers', async() => {
    // risk: data accuracy — the old loop waited for an event that, on the iMac, never came
    h.vault.answering = false;
    h.creation.start();
    await h.creation.poke();
    expect(h.vault.created).toBe(0);
    expect(h.traces).toContain('vault creation waiting: vault service not ready yet');

    h.vault.answering = true; // container comes up; no event is delivered
    await vi.advanceTimersByTimeAsync(TIMING.pollMs);

    expect(h.vault.created).toBe(1);
    expect(h.lifecycleUnlocked).toBe(true);
  });

  it('a Cloud vault lookup that never answers times out and a later attempt still creates the vault', async() => {
    // risk: irreversible — a hung lookup used to hold the single-flight flag forever, silently
    let calls = 0;
    h.gate = () => (++calls === 1 ? new Promise<VaultCreationDisposition>(() => undefined) : Promise.resolve('create'));
    h.creation.start();

    const first = h.creation.poke();
    await vi.advanceTimersByTimeAsync(TIMING.stepTimeoutMs);
    await first;
    expect(h.vault.created).toBe(0);
    expect(h.errors.some(message => message.includes('Cloud vault lookup did not answer'))).toBe(true);

    await vi.advanceTimersByTimeAsync(TIMING.retryInitialMs);

    expect(calls).toBe(2);
    expect(h.vault.created).toBe(1);
  });

  it('upgrade over an older install: stale desktop identity files do not block creation when the container vault is empty', async() => {
    // risk: data accuracy — the container's own status (setup required) decides, not leftover host files
    h.vault.setupRequired = true;
    h.vault.unlocked = false;

    await h.creation.poke();

    expect(h.vault.created).toBe(1);
  });

  it('never re-creates over an existing locked vault from an earlier install', async() => {
    // risk: irreversible data loss — creating over a populated vault would orphan its secrets
    h.vault.setupRequired = false;
    h.vault.unlocked = false;

    await h.creation.poke();

    expect(h.vault.created).toBe(0);
    expect(h.traces.some(message => message.includes('a vault from an earlier install exists and is locked'))).toBe(true);
  });

  it('an expired-sign-in hold is reported, and creation resumes once a fresh sign-in clears it', async() => {
    // risk: data accuracy — the hold used to return silently forever
    h.hold = true;
    h.creation.start();
    await h.creation.poke();
    expect(h.vault.created).toBe(0);
    expect(h.traces.some(message => message.includes('waiting for a fresh sign-in'))).toBe(true);

    h.hold = false;
    await vi.advanceTimersByTimeAsync(TIMING.pollMs);

    expect(h.vault.created).toBe(1);
  });

  it('restart: a stale locked publication right after creation is corrected from the container', async() => {
    // risk: permissions — chat, Files and integrations stay gated while the container is in fact unlocked
    await h.creation.poke();
    h.lifecycleUnlocked = false; // the vault service start-up read raced the creation and published 'locked'

    await h.creation.onLifecycleLocked();

    expect(h.lifecycleUnlocked).toBe(true);
    expect(h.published).toBe(2);
  });

  it('a lock long after creation is left alone', async() => {
    // risk: permissions — an owner-requested lock must never be undone
    await h.creation.poke();
    await vi.advanceTimersByTimeAsync(TIMING.staleLockWindowMs + 1);
    h.lifecycleUnlocked = false;

    await h.creation.onLifecycleLocked();

    expect(h.lifecycleUnlocked).toBe(false);
    expect(h.published).toBe(1);
  });

  it('does nothing without a held Cloud key', async() => {
    // risk: irreversible — no key means no vault may be created
    h.keyHeld = false;

    await h.creation.poke();

    expect(h.vault.created).toBe(0);
  });
});

describe('DesktopEnrollmentCoordinator Cloud lookup', () => {
  it('a lookup that never answers is not cached: the next gate asks Cloud again and gets the answer', async() => {
    // risk: irreversible — a cached hung lookup blocked vault creation for the whole run
    let lookups = 0;
    const deps = {
      session:   { userId: async() => 'user-0001' },
      transport: {
        enrollmentState: () => (++lookups === 1 ? new Promise(() => undefined) : Promise.resolve({ state: 'no_vault' })),
      },
      opener:          { open: async() => undefined },
      lookupTimeoutMs: 1_000,
    } as unknown as DesktopEnrollmentDependencies;
    const coordinator = new DesktopEnrollmentCoordinator(deps);

    const first = coordinator.gate();
    const settled = expect(first).rejects.toThrow('enrollment_lookup_timeout');
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    await expect(coordinator.gate()).resolves.toBe('create');
    expect(lookups).toBe(2);
  });
});
