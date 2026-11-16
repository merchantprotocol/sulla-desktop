// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import type { PostgresAuthState } from '@pkg/backend/PostgresAuthHardening';
import { PostgresAuthLifecycle } from '@pkg/backend/PostgresAuthLifecycle';

/** Records the order of hardening steps, regeneration and the Accounts refresh. */
class Recorder {
  readonly order: string[] = [];
  convergeResult: boolean | Error = true;
  applyResult: PostgresAuthState | Error = { kind: 'scram', changed: true };

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
  };

  readonly accounts = {
    refreshAccounts: async(): Promise<boolean> => {
      this.order.push('refresh accounts');

      return true;
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

  // risk: availability — a database that cannot be inspected must never stop the secret change
  it('still regenerates when converge fails or throws', async() => {
    for (const result of [false, new Error('docker unavailable')]) {
      const recorder = new Recorder();

      recorder.convergeResult = result;
      await recorder.lifecycle().aroundSecretChange(async() => {
        recorder.order.push('regenerate');
      });

      expect(recorder.order).toEqual(['converge', 'regenerate', 'refresh accounts']);
    }
  });

  it('propagates a regeneration failure as before', async() => {
    const recorder = new Recorder();

    await expect(recorder.lifecycle().aroundSecretChange(async() => {
      throw new Error('compose failed');
    })).rejects.toThrow('compose failed');
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

    recorder.hardening.apply = () => new Promise<PostgresAuthState>((resolve) => {
      finish = resolve;
    });
    const tracked = recorder.lifecycle().afterFirstPass(1, status);

    expect(status.get('postgresAuth')).toBe('checking');
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
