// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'crypto';

import { describe, expect, it } from 'vitest';

import type { DriftStatus } from '@pkg/backend/ContainerDriftReconciler';
import { ComposePostgresAuthConsumers } from '@pkg/backend/PostgresAuthConsumers';
import type { GuestDockerResult, StdinDockerCli } from '@pkg/backend/QuietGuestDockerStdin';
import type { ComposeServiceTarget } from '@pkg/backend/sullaComposeContainers';

const NEW_SECRET = 'new-secret-Zq9vYt3mKp7wLx2nRb5c';
const OLD_SECRET = 'old-secret-Hj4sDf8gUi1oPa6eTy0r';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ok = (stdout = ''): GuestDockerResult => ({ code: 0, stdout, stderr: '' });
const fail = (): GuestDockerResult => ({ code: 1, stdout: '', stderr: 'Error' });

interface FakeContainer {
  running: boolean;
  /** What each fresh-login attempt answers, in order (then 'ok'): 'ok' or an error code. */
  logins?: string[];
}

/** The guest Docker CLI: inspect, exec (health checks and the Accounts sha256sum) and restart. */
class FakeGuestDocker implements StdinDockerCli {
  readonly containers = new Map<string, FakeContainer>();
  readonly calls: string[][] = [];
  /** What Accounts copied into its private dir when it last started. */
  accountsStartedWith = OLD_SECRET;
  /** The value the restarted Accounts reads (the guest copy of the host file). */
  accountsFileValue = NEW_SECRET;
  restartFails = false;

  async run(args: string[]): Promise<GuestDockerResult> {
    this.calls.push(args);
    const container = this.containers.get(args[args.length - 1]);

    if (args[0] === 'inspect') {
      return container ? ok(`${ container.running }\n`) : fail();
    }
    if (args[0] === 'restart') {
      if (this.restartFails) return fail();
      this.accountsStartedWith = this.accountsFileValue;

      return ok();
    }
    if (args[0] === 'exec' && args.includes('sha256sum')) {
      return ok(`${ sha(this.accountsStartedWith) }  ${ args[args.length - 1] }\n`);
    }
    if (args[0] === 'exec' && args.includes('node')) {
      const login = this.containers.get(args[args.indexOf('node') - 1])?.logins?.shift() ?? 'ok';

      if (login === 'timeout') throw new Error('docker exec did not answer within 30s');

      return login === 'ok' ? ok() : { code: 1, stdout: login, stderr: '' };
    }
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }
}

class FakeDrift {
  readonly statuses = new Map<string, DriftStatus>();

  async status(target: ComposeServiceTarget): Promise<DriftStatus> {
    return this.statuses.get(target.service) ?? 'unchanged';
  }
}

function setup(hostPassword = NEW_SECRET) {
  const docker = new FakeGuestDocker();
  const drift = new FakeDrift();
  const lines: string[] = [];
  const waited: string[] = [];
  let clock = 0;
  const consumers = new ComposePostgresAuthConsumers(
    docker, drift, '/host/accounts/database.password',
    async target => { waited.push(target.container) },
    { log: line => lines.push(line), warn: line => lines.push(line) },
    { perServiceMs: 10_000, pollMs: 2_000, accountsRestartSec: 60 },
    async() => Buffer.from(hostPassword),
    async ms => { clock += ms },
    () => clock,
  );

  return { docker, drift, lines, waited, consumers };
}

describe('ComposePostgresAuthConsumers', () => {
  // risk: sign-in — switching to scram while a consumer still runs with an old secret locks it out of the database
  it('reports running consumers whose hash drifted or cannot be read; ignores unchanged and stopped ones', async() => {
    const { drift, consumers } = setup();

    drift.statuses.set('sulla_vault', 'unchanged').set('workflow_manager', 'drifted')
      .set('tools', 'not-running').set('sulla_files', 'unknown');

    expect(await consumers.driftedConsumers()).toEqual(['workflow_manager', 'sulla_files']);
  });

  it('reports no drift when every consumer matches the compose file', async() => {
    const { consumers } = setup();

    expect(await consumers.driftedConsumers()).toEqual([]);
  });

  // risk: sign-in — Accounts reads its password file only at start; a changed secret needs a restart
  it('restarts Accounts when the password it started with differs from the current one, then reports it current', async() => {
    const { docker, waited, lines, consumers } = setup();

    docker.containers.set('sulla_accounts', { running: true });

    expect(await consumers.accountsCurrent()).toBe(true);
    expect(docker.calls.filter(args => args[0] === 'restart')).toEqual([['restart', 'sulla_accounts']]);
    expect(waited).toEqual(['sulla_accounts']);
    // risk: data exposure — neither value nor its use leaks into argv or logs
    const everything = [...docker.calls.flat(), ...lines].join('\n');

    expect(everything).not.toContain(NEW_SECRET);
    expect(everything).not.toContain(OLD_SECRET);
  });

  it('leaves Accounts alone when it already runs with the current password', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_accounts', { running: true });
    docker.accountsStartedWith = NEW_SECRET;

    expect(await consumers.accountsCurrent()).toBe(true);
    expect(docker.calls.some(args => args[0] === 'restart')).toBe(false);
  });

  it('treats a stopped Accounts as current without restarting it', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_accounts', { running: false });

    expect(await consumers.accountsCurrent()).toBe(true);
    expect(docker.calls.some(args => args[0] === 'restart' || args.includes('sha256sum'))).toBe(false);
  });

  it('reports Accounts stale when it still runs an old password after the restart', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_accounts', { running: true });
    docker.accountsFileValue = OLD_SECRET; // the guest copy was not updated

    expect(await consumers.accountsCurrent()).toBe(false);
  });

  it('throws from accountsCurrent when the restart fails, and refreshAccounts swallows it', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_accounts', { running: true });
    docker.restartFails = true;

    await expect(consumers.accountsCurrent()).rejects.toThrow('could not be restarted');
    await expect(consumers.refreshAccounts()).resolves.toBe(false);
  });

  // risk: sign-in — warm pools hide a broken login; each running consumer must log in over a NEW connection
  it('opens a fresh login inside each running consumer with its own URL source, never the value', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_vault', { running: true })
      .set('sulla_tools', { running: false })
      .set('sulla_files', { running: true })
      .set('sulla_accounts', { running: true });

    await consumers.waitHealthy();

    const logins = docker.calls.filter(args => args.includes('node'))
      .map(args => args.filter(arg => arg !== ComposePostgresAuthConsumers.FRESH_LOGIN_SCRIPT));

    expect(logins).toEqual([
      ['exec', 'sulla_vault', 'node', '-e', 'env', 'SULLA_VAULT_DATABASE_URL'],
      ['exec', 'sulla_files', 'node', '-e', 'env', 'SULLA_FILES_DATABASE_URL'],
      ['exec', '-u', '0', 'sulla_accounts', 'node', '-e', 'file', '/run/sulla-accounts-private/database.url'],
    ]);
  });

  it('retries a consumer that is not reachable yet until it logs in', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_workflow_manager', { running: true, logins: ['ECONNREFUSED', 'timeout', 'ok'] });

    await consumers.waitHealthy();

    expect(docker.calls.filter(args => args.includes('node'))).toHaveLength(3);
  });

  // risk: sign-in — a wrong password must fail the wait at once so hardening rolls back to trust
  it('rejects at once, naming the consumer, when its fresh login is refused with 28P01', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_tools', { running: true, logins: ['28P01'] });

    await expect(consumers.waitHealthy()).rejects.toThrow('tools could not authenticate (28P01)');
    expect(docker.calls.filter(args => args.includes('node'))).toHaveLength(1);
  });

  it('rejects naming the consumer that cannot connect within its own timeout', async() => {
    const { docker, consumers } = setup();

    docker.containers.set('sulla_workflow_manager', { running: true, logins: Array(100).fill('ECONNREFUSED') });

    await expect(consumers.waitHealthy()).rejects.toThrow('workflow_manager could not open a database connection (ECONNREFUSED)');
  });

  // risk: availability — one stuck fresh-login exec must not eat the whole hardening bound; logins run on their own short-timeout runner
  it('runs fresh logins on the dedicated login runner and everything else on the main runner', async() => {
    const docker = new FakeGuestDocker();
    const login = new FakeGuestDocker();
    let clock = 0;

    docker.containers.set('sulla_vault', { running: true });
    login.containers.set('sulla_vault', { running: true });
    const consumers = new ComposePostgresAuthConsumers(docker, new FakeDrift(), '/host/accounts/database.password', async() => undefined,
      { log: () => undefined, warn: () => undefined }, { perServiceMs: 10_000, pollMs: 2_000, accountsRestartSec: 60 },
      async() => Buffer.from(NEW_SECRET), async(ms) => { clock += ms }, () => clock, login);

    await consumers.waitHealthy();

    expect(docker.calls.some(args => args.includes('node'))).toBe(false);
    expect(login.calls.filter(args => args.includes('node'))).toHaveLength(1);
    expect(docker.calls.filter(args => args[0] === 'inspect').length).toBeGreaterThan(0);
  });

  // risk: availability — once hardening stops waiting (bound reached), no further docker execs are started
  it('stops starting checks once the signal aborts', async() => {
    const { docker, consumers } = setup();
    const stop = new AbortController();

    docker.containers.set('sulla_vault', { running: true, logins: ['ECONNREFUSED', 'ECONNREFUSED', 'ECONNREFUSED'] })
      .set('sulla_tools', { running: true });
    const run = docker.run.bind(docker);

    docker.run = async(args) => {
      const result = await run(args);

      if (args.includes('node')) {
        stop.abort(); // the bound fired while the first login attempt ran
      }

      return result;
    };

    await expect(consumers.waitHealthy(stop.signal)).rejects.toThrow('stopped');
    expect(docker.calls.filter(args => args.includes('node'))).toHaveLength(1);
    expect(docker.calls.some(args => args.includes('sulla_tools'))).toBe(false);
  });
});
