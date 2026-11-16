// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { PostgresAuthHardening } from '@pkg/backend/PostgresAuthHardening';
import type { PostgresAuthState, PostgresAuthTrustReason } from '@pkg/backend/PostgresAuthHardening';
import { PostgresAuthLifecycle } from '@pkg/backend/PostgresAuthLifecycle';
import { PostgresScramVerifier } from '@pkg/backend/PostgresScramVerifier';
import { GuestPostgresAuthRepository } from '@pkg/backend/Repositories/GuestPostgresAuthRepository';

import { DEV_PASSWORD, FakeClock, FakeGuestPostgres, HEALTH_TIMEOUT_MS, SECRET } from '../../Support/PostgresAuth/FakeGuestPostgres';

/** Records the order of hardening steps, regeneration and the Accounts refresh. */
class Recorder {
  readonly order: string[] = [];
  convergeResult: boolean | Error = true;
  applyResult: PostgresAuthState | Error = { kind: 'scram', changed: true };
  refreshResult = true;

  readonly hardening = {
    converge: async(): Promise<boolean> => {
      this.order.push('converge');
      if (this.convergeResult instanceof Error) throw this.convergeResult;

      return this.convergeResult;
    },
    apply: async(): Promise<PostgresAuthState> => {
      this.order.push('apply');
      if (this.applyResult instanceof Error) throw this.applyResult;

      return this.applyResult;
    },
    restoreTrust: async(reason: PostgresAuthTrustReason, detail?: string): Promise<PostgresAuthState> => {
      this.order.push(`restore trust (${ reason })`);

      return detail ? { kind: 'trust', reason, detail } : { kind: 'trust', reason };
    },
  };

  readonly accounts = {
    refreshAccounts: async(): Promise<boolean> => {
      this.order.push('refresh accounts');

      return this.refreshResult;
    },
  };

  readonly lines: string[] = [];

  lifecycle(): PostgresAuthLifecycle {
    return new PostgresAuthLifecycle(this.hardening, this.accounts, { log: line => this.lines.push(line), warn: line => this.lines.push(line) });
  }
}

describe('PostgresAuthLifecycle', () => {
  // risk: sign-in — under scram, consumers recreated with a new secret before the role has it lose database access
  it('converges the role password before compose is regenerated, then refreshes Accounts', async() => {
    const recorder = new Recorder();

    await recorder.lifecycle().aroundSecretChange(async() => {
      recorder.order.push('regenerate');
    });

    expect(recorder.order).toEqual(['converge', 'regenerate', 'refresh accounts']);
  });

  // risk: sign-in — consumers are about to get a secret the role does not have: trust goes back first, regeneration still runs
  it('restores trust before regenerating when converge fails or throws', async() => {
    for (const result of [false, new Error('docker unavailable')]) {
      const recorder = new Recorder();
      const lifecycle = recorder.lifecycle();
      const status = new Map<string, string>();

      await lifecycle.afterFirstPass(1, status);
      recorder.order.length = 0;
      recorder.convergeResult = result;
      await lifecycle.aroundSecretChange(async() => {
        recorder.order.push('regenerate');
      });

      expect(recorder.order).toEqual(['converge', 'restore trust (role-password-not-set)', 'regenerate', 'refresh accounts']);
      expect(status.get('postgresAuth')).toBe('trust (role-password-not-set)');
    }
  });

  // risk: sign-in — a failed regeneration can leave consumers on the old secret while the role has the new one
  it('restores trust and rethrows when regeneration fails', async() => {
    const recorder = new Recorder();
    const lifecycle = recorder.lifecycle();
    const status = new Map<string, string>();

    await lifecycle.afterFirstPass(1, status);
    recorder.order.length = 0;

    await expect(lifecycle.aroundSecretChange(async() => {
      recorder.order.push('regenerate');
      throw new Error('compose failed');
    })).rejects.toThrow('compose failed');
    expect(recorder.order).toEqual(['converge', 'regenerate', 'restore trust (consumer-drift)']);
    expect(status.get('postgresAuth')).toBe('trust (consumer-drift)');
    expect(recorder.lines.at(-1)).toBe('[Sulla] Boot services: postgresAuth=trust (consumer-drift) (after a service secret change)');
  });

  // risk: sign-in — Accounts still on the old password under scram cannot log in
  it('restores trust when Accounts does not pick up the new password', async() => {
    const recorder = new Recorder();
    const lifecycle = recorder.lifecycle();
    const status = new Map<string, string>();

    await lifecycle.afterFirstPass(1, status);
    recorder.order.length = 0;
    recorder.refreshResult = false;

    await lifecycle.aroundSecretChange(async() => {
      recorder.order.push('regenerate');
    });
    expect(recorder.order).toEqual(['converge', 'regenerate', 'refresh accounts', 'restore trust (accounts-stale)']);
    expect(status.get('postgresAuth')).toBe('trust (accounts-stale)');
  });

  it('does not touch trust when the secret change fully succeeds', async() => {
    const recorder = new Recorder();
    const status = new Map<string, string>();
    const lifecycle = recorder.lifecycle();

    await lifecycle.afterFirstPass(1, status);
    await lifecycle.aroundSecretChange(async() => undefined);

    expect(recorder.order.some(step => step.startsWith('restore trust'))).toBe(false);
    expect(status.get('postgresAuth')).toBe('scram');
  });

  // risk: sign-in — two role-password writers must never interleave
  it('runs a secret change only after an apply in flight has finished', async() => {
    const recorder = new Recorder();
    const lifecycle = recorder.lifecycle();
    let finish!: (state: PostgresAuthState) => void;

    recorder.hardening.apply = () => {
      recorder.order.push('apply start');

      return new Promise<PostgresAuthState>((resolve) => {
        finish = (state) => {
          recorder.order.push('apply end');
          resolve(state);
        };
      });
    };
    const applied = lifecycle.afterFirstPass(1, new Map());
    const changed = lifecycle.aroundSecretChange(async() => {
      recorder.order.push('regenerate');
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(recorder.order).toEqual(['apply start']);
    finish({ kind: 'scram', changed: true });
    await Promise.all([applied, changed]);
    expect(recorder.order).toEqual(['apply start', 'apply end', 'converge', 'regenerate', 'refresh accounts']);
  });

  // risk: availability — boot never waits long behind a running apply; its converge still runs in order afterwards
  it('lets boot continue when its converge is queued behind a running step', async() => {
    const recorder = new Recorder();
    const lifecycle = new PostgresAuthLifecycle(recorder.hardening, recorder.accounts, { log: () => undefined, warn: line => recorder.lines.push(line) }, 5);
    let finish!: (state: PostgresAuthState) => void;

    recorder.hardening.apply = () => new Promise<PostgresAuthState>((resolve) => {
      finish = resolve;
    });
    void lifecycle.afterFirstPass(1, new Map());

    expect(await lifecycle.afterPostgresHealthy()).toBe(false);
    expect(recorder.order).toEqual([]);
    expect(recorder.lines).toContain('[PostgresAuth] the role password converge is queued behind a running step; boot continues');
    finish({ kind: 'scram', changed: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(recorder.order).toEqual(['converge']);
  });

  // risk: sign-in — apply with secret A racing a secret change to B must end with the role on B, never scram with A
  it('ends with the role on the new secret when a secret change lands while apply runs (real hardening)', async() => {
    const events: string[] = [];
    const clock = new FakeClock(events);
    const server = new FakeGuestPostgres(events, clock);
    const source = { current: SECRET, async value() { return this.current; } };
    const rotated = 'Rotated_ServiceSecret-adopted-from-the-database-02';
    const setPasswords: string[] = [];
    let secretChange: Promise<void> | undefined;
    const consumers = {
      driftedConsumers: async() => [],
      accountsCurrent:  async() => true,
      waitHealthy:      async() => undefined,
    };
    const hardening = new PostgresAuthHardening(new GuestPostgresAuthRepository(server), source, consumers,
      { log: () => undefined, warn: () => undefined }, () => 'a-wrong-password', DEV_PASSWORD, { sleep: clock.sleep, healthTimeoutMs: HEALTH_TIMEOUT_MS });
    const lifecycle = new PostgresAuthLifecycle(hardening, { refreshAccounts: async() => true }, { log: () => undefined, warn: () => undefined });
    const run = server.run.bind(server);

    server.run = async(args, input) => {
      if (input?.includes('ALTER ROLE')) {
        setPasswords.push(input);
      }
      // The first thing apply does is read the role verifier: the secret changes right then.
      if (!secretChange && args.join(' ').includes('pg_authid')) {
        source.current = rotated;
        secretChange = lifecycle.aroundSecretChange(async() => {
          events.push('regenerate');
        });
        await new Promise(resolve => setTimeout(resolve, 5)); // without serialisation the change would finish here
      }

      return run(args, input);
    };

    const status = new Map<string, string>();

    await lifecycle.afterFirstPass(1, status);
    await secretChange;

    const lastSet = /PASSWORD '([^']+)'/.exec(setPasswords.at(-1) ?? '')?.[1] ?? null;

    expect(PostgresScramVerifier.parse(lastSet)?.matches(rotated)).toBe(true);
    expect(PostgresScramVerifier.parse(server.verifier)?.matches(rotated)).toBe(true);
    expect(status.get('postgresAuth')).toBe('scram');
    expect(await hardening.verify()).toBe(true); // the secret consumers now get logs in under scram
    expect(events.indexOf('regenerate')).toBeGreaterThan(events.lastIndexOf('reload'));
  });

  // risk: data exposure — the boot status must not read healthy while network logins are still trusted
  it('records scram in the boot status only when hardening switched (or already was) scram', async() => {
    const recorder = new Recorder();
    const status = new Map<string, string>();

    await recorder.lifecycle().afterFirstPass(1, status);
    expect(status.get('postgresAuth')).toBe('scram');

    for (const [state, text] of [
      [{ kind: 'trust', reason: 'probe-failed', detail: 'timeout' }, 'trust (probe-failed)'],
      [{ kind: 'trust', reason: 'rolled-back' }, 'trust (rolled-back)'],
      [{ kind: 'trust', reason: 'legacy-development-secret' }, 'trust (legacy-development-secret)'],
    ] as const) {
      const failing = new Recorder();
      const boot = new Map<string, string>();

      failing.applyResult = state;
      await failing.lifecycle().afterFirstPass(1, boot);
      expect(boot.get('postgresAuth')).toBe(text);
    }
  });

  it('records trust (unavailable) instead of throwing when apply rejects', async() => {
    const recorder = new Recorder();
    const status = new Map<string, string>();

    recorder.applyResult = new Error('boom');
    await expect(recorder.lifecycle().afterFirstPass(1, status)).resolves.toBeUndefined();
    expect(status.get('postgresAuth')).toBe('trust (unavailable)');
  });

  // risk: availability — the scram switch (probes, fresh logins) must never hold boot
  it('does not hold the caller: records checking at once and the result when apply lands', async() => {
    const recorder = new Recorder();
    const status = new Map<string, string>();
    let finish!: (state: PostgresAuthState) => void;
    let applyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      applyStarted = resolve;
    });

    // apply runs on the lifecycle's serial chain, so it starts a tick after afterFirstPass returns.
    recorder.hardening.apply = () => new Promise<PostgresAuthState>((resolve) => {
      finish = resolve;
      applyStarted();
    });
    const tracked = recorder.lifecycle().afterFirstPass(1, status);

    expect(status.get('postgresAuth')).toBe('checking');
    await started;
    expect(status.get('postgresAuth')).toBe('checking'); // apply is running; the caller was not held
    finish({ kind: 'trust', reason: 'consumer-drift', detail: 'tools' });
    await tracked;
    expect(status.get('postgresAuth')).toBe('trust (consumer-drift)');
    expect(recorder.lines).toContain('[Sulla] Boot services: postgresAuth=trust (consumer-drift)');
  });

  it('applies once per services generation and again for a new generation', async() => {
    const recorder = new Recorder();
    const lifecycle = recorder.lifecycle();

    await lifecycle.afterFirstPass(3, new Map());
    await lifecycle.afterFirstPass(3, new Map());
    await lifecycle.afterFirstPass(4, new Map());

    expect(recorder.order).toEqual(['apply', 'apply']);
  });

  it('converges after PostgreSQL is healthy without throwing', async() => {
    const recorder = new Recorder();

    recorder.convergeResult = new Error('psql failed');

    await expect(recorder.lifecycle().afterPostgresHealthy()).resolves.toBe(false);
  });
});
