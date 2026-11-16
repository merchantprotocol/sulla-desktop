// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresAuthHardening } from '@pkg/backend/PostgresAuthHardening';
import type { PostgresAuthConsumers } from '@pkg/backend/PostgresAuthHardening';
import { PostgresScramVerifier } from '@pkg/backend/PostgresScramVerifier';
import { GuestPostgresAuthRepository } from '@pkg/backend/Repositories/GuestPostgresAuthRepository';

import {
  DEV_PASSWORD, FakeClock, FakeGuestPostgres, HEALTH_TIMEOUT_MS, SECRET, TRUST_INSTALL_HBA, WRONG_PASSWORD,
} from '../../Support/PostgresAuth/FakeGuestPostgres';

class FakeConsumers implements PostgresAuthConsumers {
  drifted: string[] = [];
  accounts = true;
  healthError?: Error;
  /** waitHealthy() never settles (a consumer that never answers). */
  hang = false;
  readonly signals: (AbortSignal | undefined)[] = [];

  constructor(private readonly events: string[]) {}

  async driftedConsumers(): Promise<string[]> {
    this.events.push('drift');

    return this.drifted;
  }

  async accountsCurrent(): Promise<boolean> {
    this.events.push('accounts');

    return this.accounts;
  }

  async waitHealthy(signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    this.events.push('health');
    if (this.healthError) throw this.healthError;
    if (this.hang) await new Promise(() => undefined);
  }
}

/** True when any docker call could end another session (pg_terminate_backend / pg_cancel_backend). */
function endsSessions(server: FakeGuestPostgres): boolean {
  return server.calls.some(call => /pg_(terminate|cancel)_backend/i.test(`${ call.args.join(' ') } ${ call.input ?? '' }`));
}

class Logger {
  readonly lines: string[] = [];
  log(message: string) { this.lines.push(message); }
  warn(message: string) { this.lines.push(message); }
}

function setup(secret = SECRET) {
  const events: string[] = [];
  const clock = new FakeClock(events);
  const server = new FakeGuestPostgres(events, clock);
  const consumers = new FakeConsumers(events);
  const logger = new Logger();
  const source = { current: secret, async value() { return this.current; } };
  const hardening = new PostgresAuthHardening(new GuestPostgresAuthRepository(server), source, consumers, logger,
    () => WRONG_PASSWORD, DEV_PASSWORD, { sleep: clock.sleep, healthTimeoutMs: HEALTH_TIMEOUT_MS });

  return { events, server, consumers, logger, source, clock, hardening };
}

describe('PostgresAuthHardening', () => {
  // risk: permissions — an upgraded trust install ends with network logins requiring the secret
  it('switches an upgraded trust install to scram in order: role password, gates, backup, write, rule check, reload, verify, health', async() => {
    const { events, server, logger, hardening } = setup();

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: true });
    expect(events).toEqual(['alter-role', 'drift', 'accounts', 'probe', 'backup', 'write', 'rules', 'sleep:1100', 'reload', 'probe', 'probe', 'health']);
    expect(server.hba).toBe(PostgresAuthHardening.MANAGED_HBA);
    expect(server.hba.split('\n')[0]).toBe('# managed-by: sulla-desktop postgres-auth v1');
    expect(server.backup).toBe(TRUST_INSTALL_HBA);
    expect(PostgresScramVerifier.parse(server.verifier)?.matches(SECRET)).toBe(true);
    expect(logger.lines).toContain('[PostgresAuth] state=scram (switched from trust)');
    expect(await hardening.verify()).toBe(true);
  });

  // risk: secret exposure — argv is visible in `ps` and Docker logs; log lines persist
  it('never puts the secret in argv, in a log line, or in plaintext into the server', async() => {
    const { server, logger, consumers, hardening } = setup();

    await hardening.apply();
    // A consumer error that (wrongly) carries the secret must still be masked in the log.
    server.hba = TRUST_INSTALL_HBA;
    server.loaded = TRUST_INSTALL_HBA;
    consumers.healthError = new Error(`sulla_tools refused postgres://sulla:${ SECRET }@postgres/sulla`);
    await hardening.apply();

    for (const call of server.calls) {
      expect(call.args.join(' ')).not.toContain(SECRET);
      if (call.input?.includes('ALTER ROLE')) {
        expect(call.input).not.toContain(SECRET);
        expect(call.input).toMatch(/PASSWORD 'SCRAM-SHA-256\$4096:/);
      }
    }
    expect(server.calls.some(call => call.input === SECRET)).toBe(true); // only the probe's stdin carries it
    expect(logger.lines.join('\n')).not.toContain(SECRET);
    expect(logger.lines.join('\n')).toContain('[redacted]');
  });

  // risk: data accuracy — a converged install is left alone on every later boot, without a deliberate failed login (FATAL noise)
  it('does nothing when the managed file is live and the role already matches, and never probes a wrong password', async() => {
    const { events, server, logger, hardening } = setup();

    await hardening.apply();
    events.length = 0;
    server.calls.length = 0;

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: false });
    expect(events).toEqual(['rules', 'loaded?', 'probe']);
    expect(server.calls.some(call => call.input === WRONG_PASSWORD)).toBe(false);
    expect(logger.lines).toContain('[PostgresAuth] state=scram');
  });

  // risk: permissions — a managed file that was written but never loaded is not reported as scram
  it('finishes a switch that was interrupted after the write and before the reload', async() => {
    const { events, server, hardening } = setup();

    await hardening.converge();
    server.hba = PostgresAuthHardening.MANAGED_HBA;
    server.backup = TRUST_INSTALL_HBA;
    events.length = 0;

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: true });
    expect(events).toEqual(['rules', 'loaded?', 'drift', 'accounts', 'probe', 'backup', 'write', 'rules', 'sleep:1100', 'reload', 'probe', 'probe', 'health']);
    expect(server.loaded).toBe(PostgresAuthHardening.MANAGED_HBA);
    expect(server.backup).toBe(TRUST_INSTALL_HBA);
  });

  // risk: outage — a consumer still running the old secret would lose the database
  it('keeps trust when a database consumer has drifted from its desired compose configuration', async() => {
    const { events, server, consumers, logger, hardening } = setup();

    consumers.drifted = ['sulla_vault'];

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'consumer-drift', detail: 'sulla_vault' });
    expect(events).toEqual(['alter-role', 'drift']);
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.backup).toBeNull();
    expect(logger.lines.at(-1)).toMatch(/^\[PostgresAuth\] state=trust \(.*sulla_vault\)$/);
  });

  // risk: outage — accounts reads its password file only at start
  it('keeps trust when accounts has not picked up the current database password', async() => {
    const { events, server, consumers, hardening } = setup();

    consumers.accounts = false;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'accounts-stale' });
    expect(events).not.toContain('write');
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
  });

  // risk: permissions — the public development password must not be the only thing guarding the database
  it('keeps trust and says so when the stored secret is the legacy development password', async() => {
    const { events, server, logger, hardening } = setup(DEV_PASSWORD);

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'legacy-development-secret' });
    expect(events).toEqual([]); // only reads: no role change, write or reload
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(logger.lines).toEqual(['[PostgresAuth] state=trust (legacy development secret; rotation pending)']);
  });

  // risk: outage — never switch when the secret cannot even reach the server over TCP
  it('keeps trust when the pre-switch TCP probe fails', async() => {
    const { events, server, hardening } = setup();

    server.tcpDown = true;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'probe-failed', detail: 'error' });
    expect(events).not.toContain('backup');
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
  });

  // risk: permissions — a switch that still lets a wrong password in is rolled back, not reported as secure
  it('rolls back when a wrong password still logs in after the reload', async() => {
    const { events, server, logger, hardening } = setup();

    server.acceptsAnyPassword = true;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'rolled-back', detail: 'verification failed' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
    expect(events.slice(-4)).toEqual(['probe', 'probe', 'write', 'reload']);
    expect(logger.lines.some(line => line.startsWith('[PostgresAuth] rolled back:'))).toBe(true);
  });

  // risk: outage — the secret itself refused after the reload must put trust back
  it('rolls back when the secret cannot log in after the reload', async() => {
    const { server, hardening } = setup();

    server.refusesSecret = true;

    expect(await hardening.apply()).toMatchObject({ kind: 'trust', reason: 'rolled-back' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: outage — a consumer that cannot reconnect under scram puts trust back
  it('rolls back when a database consumer is not healthy over fresh connections', async() => {
    const { events, server, consumers, hardening } = setup();

    consumers.healthError = new Error('sulla_vault did not become healthy');

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'rolled-back', detail: 'sulla_vault did not become healthy' });
    expect(events.slice(-4)).toEqual(['probe', 'health', 'write', 'reload']);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: outage — a broken hba file must never be loaded
  it('never reloads when the written file has rule errors, and puts the old file back', async() => {
    const { events, server, hardening } = setup();

    server.ruleErrors = ['3: invalid authentication method "scram-sha-257"'];

    expect(await hardening.apply()).toMatchObject({ kind: 'trust', reason: 'hba-rule-errors' });
    expect(events).not.toContain('reload');
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: outage — a failed write leaves the running rules untouched
  it('keeps trust without reloading when the hba file cannot be written', async() => {
    const { events, server, hardening } = setup();

    server.failWrite = true;

    expect(await hardening.apply()).toMatchObject({ kind: 'trust', reason: 'switch-failed' });
    expect(events).not.toContain('reload');
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: data accuracy — the one-time backup keeps the original file across retries
  it('never overwrites an existing pre-switch backup', async() => {
    const { server, hardening } = setup();

    server.backup = 'the original file\n';
    server.hba = 'host all all all trust\n';
    server.loaded = server.hba;

    await hardening.apply();
    expect(server.backup).toBe('the original file\n');
  });

  // risk: outage — rollback without a usable backup still restores trust when the managed file is active
  it('rolls back to a trust file when there is no unmanaged backup', async() => {
    const { server, hardening } = setup();

    server.hba = PostgresAuthHardening.MANAGED_HBA;
    server.loaded = server.hba;

    expect(await hardening.rollback('drill')).toBe(true);
    expect(server.hba).toBe(PostgresAuthHardening.TRUST_HBA);
    expect(server.loaded).toBe(PostgresAuthHardening.TRUST_HBA);
  });

  // risk: data accuracy — rollback never replaces an unmanaged file it did not write
  it('leaves an unmanaged hba file alone on rollback when there is no backup', async() => {
    const { server, hardening } = setup();

    server.hba = 'local all all trust\nhost replication all all trust\nhost all all all trust\n';

    await hardening.rollback('drill');
    expect(server.hba).toBe('local all all trust\nhost replication all all trust\nhost all all all trust\n');
  });

  // risk: outage — when the secret changes, the role follows before consumers get the new value
  it('converges the role password only when it differs, and again after the secret changes', async() => {
    const { events, server, source, hardening } = setup();

    expect(await hardening.converge()).toBe(true);
    expect(await hardening.converge()).toBe(true);
    expect(events.filter(event => event === 'alter-role')).toHaveLength(1);

    source.current = 'Another_rotated-Secret_value-0123456789abcdefgh';
    expect(await hardening.converge()).toBe(true);
    expect(events.filter(event => event === 'alter-role')).toHaveLength(2);
    expect(PostgresScramVerifier.parse(server.verifier)?.matches(source.current)).toBe(true);
  });

  // risk: availability — boot never blocks on a broken Docker
  it('never throws when Docker fails; it keeps trust and reports why', async() => {
    const { logger, hardening } = setup();
    const broken = new PostgresAuthHardening(new GuestPostgresAuthRepository({
      run: () => Promise.reject(new Error('Cannot connect to the Docker daemon')),
    }), { value: async() => SECRET }, new FakeConsumers([]), logger, undefined, DEV_PASSWORD);

    expect(await broken.converge()).toBe(false);
    expect(await broken.apply()).toMatchObject({ kind: 'trust', reason: 'role-password-not-set' });
    expect(await broken.verify()).toBe(false);
    expect(await broken.rollback('drill')).toBe(false);
    expect(hardening).toBeDefined();
  });

  // risk: permissions — a secret PostgreSQL might SASLprep differently is never half-applied
  it('keeps trust for a secret it cannot turn into a SCRAM verifier', async() => {
    const { server, hardening } = setup('pässwörd-with-umlauts');

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'unsupported-secret' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
  });

  // risk: permissions — verify() reports the real state: trust accepts a wrong password
  it('does not verify a trust install', async() => {
    const { hardening } = setup();

    await hardening.converge();
    expect(await hardening.verify()).toBe(false);
  });

  // risk: outage — consumers hold session-level advisory locks (workflow scheduler leader, launch locks, Files jobs); ending their sessions kills the manager and breaks mutual exclusion
  it('never terminates or cancels any backend, on a switch, a rollback or a converged boot', async() => {
    const { server, consumers, hardening } = setup();

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: true });
    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: false });
    server.hba = TRUST_INSTALL_HBA;
    server.loaded = TRUST_INSTALL_HBA;
    consumers.healthError = new Error('sulla_tools did not become healthy');
    expect(await hardening.apply()).toMatchObject({ kind: 'trust', reason: 'rolled-back' });

    expect(endsSessions(server)).toBe(false);
  });

  // risk: outage — a managed scram file left on disk under a trust result would lock consumers out at the next PostgreSQL start
  it('restores the backup and reloads when a managed file is on disk and a gate keeps trust', async() => {
    const { events, server, consumers, hardening } = setup();

    await hardening.converge();
    server.hba = PostgresAuthHardening.MANAGED_HBA; // interrupted switch: written, never loaded
    server.backup = TRUST_INSTALL_HBA;
    consumers.drifted = ['sulla_files'];
    events.length = 0;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'consumer-drift', detail: 'sulla_files' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
    expect(events.slice(-2)).toEqual(['write', 'reload']);
  });

  // risk: outage — a live managed file whose secret no longer logs in is put back to trust on disk and in memory
  it('restores trust when the managed file is live but the secret is refused over TCP', async() => {
    const { server, hardening } = setup();

    await hardening.apply();
    server.refusesSecret = true;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'probe-failed', detail: 'auth-failed' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: permissions/outage — the reported state matches the disk even for the legacy development secret
  it('restores the backup when a managed file is on disk and the secret is the development password', async() => {
    const { server, hardening } = setup(DEV_PASSWORD);

    server.hba = PostgresAuthHardening.MANAGED_HBA;
    server.loaded = PostgresAuthHardening.MANAGED_HBA;
    server.backup = TRUST_INSTALL_HBA;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'legacy-development-secret' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: outage — a gate that throws (Docker hiccup) still leaves the disk at trust
  it('restores trust on disk when a gate throws with a managed file in place', async() => {
    const { server, consumers, hardening } = setup();

    await hardening.converge();
    server.hba = PostgresAuthHardening.MANAGED_HBA;
    server.backup = TRUST_INSTALL_HBA;
    consumers.driftedConsumers = () => Promise.reject(new Error('docker ps failed'));

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'unavailable', detail: 'docker ps failed' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
  });

  // risk: availability — pg_reload_conf() is an async SIGHUP; a probe that still sees trust must not cause a needless rollback
  it('retries verification while the reload has not taken effect yet', async() => {
    const { server, clock, hardening } = setup();

    server.reloadLag = 2; // the first verify attempt (two probes) still sees trust

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: true });
    expect(server.loaded).toBe(PostgresAuthHardening.MANAGED_HBA);
    expect(clock.sleeps.filter(ms => ms === 200)).toEqual([200]);
  });

  // risk: permissions — retries are bounded: a server that keeps accepting any password is rolled back after five attempts
  it('gives up after five verification attempts', async() => {
    const { server, clock, hardening } = setup();

    server.acceptsAnyPassword = true;

    expect(await hardening.apply()).toMatchObject({ kind: 'trust', reason: 'rolled-back' });
    expect(server.calls.filter(call => call.input === WRONG_PASSWORD)).toHaveLength(5);
    expect(clock.sleeps.filter(ms => ms === 200)).toHaveLength(4);
  });

  // risk: availability — a consumer that never answers cannot hang boot with scram half-applied
  it('rolls back when consumers are not healthy within the bound', async() => {
    const { server, consumers, clock, hardening } = setup();

    consumers.hang = true;
    clock.healthExpired = true;

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'rolled-back', detail: 'database consumers were not healthy within 30s' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: data accuracy — pg_stat_file has whole-second mtimes; a reload in the write's second leaves the live file looking unloaded and redoes the switch every boot
  it('reloads in a later whole second than the write, so the next boot takes the fast path', async() => {
    const { events, server, clock, hardening } = setup();
    let writeSecond = -1;
    const run = server.run.bind(server);

    server.run = async(args, input) => {
      const result = await run(args, input);

      if (events.at(-1) === 'write' && writeSecond < 0) {
        writeSecond = clock.second();
      }

      return result;
    };

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: true });
    const write = events.indexOf('write');

    expect(events.slice(write, events.indexOf('reload') + 1)).toEqual(['write', 'rules', 'sleep:1100', 'reload']);
    expect(server.loadSecond).toBeGreaterThan(writeSecond);
    expect(server.mtimeSecond).toBeLessThan(server.loadSecond);

    events.length = 0;
    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: false });
    expect(events).toEqual(['rules', 'loaded?', 'probe']);
  });

  // risk: permissions — a flaky docker exec on an install already on scram must not silently downgrade it to trust
  it('retries a probe that errors on a live managed file and stays scram without rewriting', async() => {
    const { events, server, hardening } = setup();

    await hardening.apply();
    events.length = 0;
    server.probeErrors = 2;

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: false });
    expect(events).toEqual(['rules', 'loaded?', 'probe', 'sleep:200', 'probe', 'sleep:200', 'probe']);
    expect(server.hba).toBe(PostgresAuthHardening.MANAGED_HBA);
  });

  // risk: permissions — a probe that keeps erroring keeps scram (reported unverified) instead of restoring trust
  it('reports scram as unverified, and keeps the managed file, when every probe on a live managed file errors', async() => {
    const { events, server, logger, hardening } = setup();

    await hardening.apply();
    events.length = 0;
    server.probeErrors = 99;

    expect(await hardening.apply()).toEqual({ kind: 'scram', changed: false, unverified: true });
    expect(events.filter(event => event === 'probe')).toHaveLength(5);
    expect(events).not.toContain('write');
    expect(events).not.toContain('drift');
    expect(server.hba).toBe(PostgresAuthHardening.MANAGED_HBA);
    expect(server.loaded).toBe(PostgresAuthHardening.MANAGED_HBA);
    expect(logger.lines.at(-1)).toBe('[PostgresAuth] state=scram (unverified: the TCP login probe did not complete)');
  });

  // risk: availability — the health bound's timer is cleared and the consumer checks are told to stop once apply() stops waiting
  it('aborts the health bound and the consumer checks once the wait ends, on success and on timeout', async() => {
    const ok1 = setup();

    expect(await ok1.hardening.apply()).toEqual({ kind: 'scram', changed: true });
    expect(ok1.consumers.signals[0]?.aborted).toBe(true);
    expect(ok1.clock.healthSignals[0]).toBe(ok1.consumers.signals[0]);

    const late = setup();

    late.consumers.hang = true;
    late.clock.healthExpired = true;
    expect(await late.hardening.apply()).toMatchObject({ kind: 'trust', reason: 'rolled-back' });
    expect(late.consumers.signals[0]?.aborted).toBe(true);
  });

  // risk: sign-in — the role must end on the secret consumers get, not on the value apply read at its start
  it('follows a secret that changes while apply runs: the role and the reported scram use the new value', async() => {
    const { server, consumers, source, logger, hardening } = setup();
    const rotated = 'Rotated_ServiceSecret-adopted-from-the-database-01';
    const gate = consumers.driftedConsumers.bind(consumers);

    consumers.driftedConsumers = async() => {
      source.current = rotated; // ServiceSecretProvider adopts the stored database value mid-apply

      return gate();
    };

    expect(await hardening.apply()).toMatchObject({ kind: 'scram' });
    expect(PostgresScramVerifier.parse(server.verifier)?.matches(rotated)).toBe(true);
    expect(PostgresScramVerifier.parse(server.verifier)?.matches(SECRET)).toBe(false);
    expect(logger.lines.join('\n')).not.toContain(rotated);
  });

  // risk: sign-in — a secret that will not settle never leaves scram live with a role the consumers may not match
  it('restores trust when the secret keeps changing while apply runs', async() => {
    const { server, source, hardening } = setup();
    let turn = 0;

    source.value = async() => `Moving_ServiceSecret-value-number-${ ++turn }-abcdefgh`; // a new value on every read

    expect(await hardening.apply()).toEqual({ kind: 'trust', reason: 'role-password-not-set', detail: 'the service secret kept changing' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
  });

  // risk: outage — restoreTrust puts back the pre-switch file when scram is live, and leaves a trust install untouched
  it('restoreTrust restores a live managed file and reports the reason; a trust install is not rewritten', async() => {
    const { events, server, logger, hardening } = setup();

    await hardening.apply();
    expect(await hardening.restoreTrust('accounts-stale')).toEqual({ kind: 'trust', reason: 'accounts-stale' });
    expect(server.hba).toBe(TRUST_INSTALL_HBA);
    expect(server.loaded).toBe(TRUST_INSTALL_HBA);
    expect(logger.lines.at(-1)).toBe('[PostgresAuth] state=trust (accounts has not picked up the current database password)');

    events.length = 0;
    await hardening.restoreTrust('role-password-not-set');
    expect(events).not.toContain('write');
    expect(events).not.toContain('reload');
  });
});

describe('PostgresAuthHardening.abortableSleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // risk: availability — a left-over 120 s timer keeps work queued after the bound is no longer needed
  it('clears its timer and resolves at once when the signal aborts', async() => {
    vi.useFakeTimers();
    const stop = new AbortController();
    let done = false;
    const sleeping = PostgresAuthHardening.abortableSleep(120_000, stop.signal).then(() => {
      done = true;
    });

    expect(vi.getTimerCount()).toBe(1);
    stop.abort();
    await sleeping;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves after the delay when not aborted', async() => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = PostgresAuthHardening.abortableSleep(1_100).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(1_099);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });
});
