// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'crypto';
import { promises as fs } from 'fs';

import type { DriftStatus } from './ContainerDriftReconciler';
import type { PostgresAuthConsumers, PostgresAuthLogger } from './PostgresAuthHardening';
import type { StdinDockerCli } from './QuietGuestDockerStdin';
import type { ComposeServiceTarget } from './sullaComposeContainers';

/** The drift check of one compose container (ContainerDriftReconciler.status). */
export interface DriftStatusSource {
  status(target: ComposeServiceTarget): Promise<DriftStatus>;
}

/** Waits until a compose container reports healthy; rejects on timeout. */
export type ServiceHealthWait = (target: ComposeServiceTarget, timeoutSec: number) => Promise<void>;

/** Where a consumer keeps its database URL: an env var of the container, or a file inside it. */
export interface ConsumerDatabaseUrl {
  target: ComposeServiceTarget;
  source: 'env' | 'file';
  /** The env var name or the in-container file path (never the value). */
  ref: string;
}

export interface PostgresAuthConsumerTimings {
  /** How long each consumer may take to log in over a fresh connection. */
  perServiceMs: number;
  /** Pause between two login attempts of a consumer that is not logging in yet. */
  pollMs: number;
  /** How long a restarted Accounts container may take to become healthy. */
  accountsRestartSec: number;
}

/**
 * What PostgresAuthHardening needs to know about PostgreSQL's clients in the
 * Desktop compose project:
 *
 * - driftedConsumers(): a running consumer whose compose hash differs from the
 *   file Desktop wrote may still carry an old secret. Uses the same hash check
 *   as the drift reconciler; a hash that cannot be read counts as drifted.
 * - accountsCurrent(): Accounts reads its database password file once, when it
 *   starts, and the secret is not in its env (so drift never recreates it). The
 *   copy it took at start is compared (by SHA-256, inside the guest) with the
 *   host value store; on a difference Accounts is restarted.
 * - waitHealthy(): inside each running consumer, a one-off Node script opens a
 *   NEW connection with that consumer's own database URL (its env var, or the
 *   Accounts private URL file) and runs `SELECT 1`. Health endpoints are no
 *   proof: their warm pools keep connections authenticated under trust. The
 *   script gets only the env var name or file path; the URL never leaves the
 *   container and only an error code comes back. 28P01 fails at once; anything
 *   else is retried until the per-service timeout.
 *
 * Nothing here logs a value; the hashes are compared, never printed.
 */
export class ComposePostgresAuthConsumers implements PostgresAuthConsumers {
  /** Compose consumers that get the service secret through their env. */
  static readonly SECRET_CONSUMERS: readonly ComposeServiceTarget[] = [
    { service: 'sulla_vault', container: 'sulla_vault' },
    { service: 'workflow_manager', container: 'sulla_workflow_manager' },
    { service: 'tools', container: 'sulla_tools' },
    { service: 'sulla_files', container: 'sulla_files' },
  ];

  static readonly ACCOUNTS: ComposeServiceTarget = { service: 'sulla_accounts', container: 'sulla_accounts' };
  /** The entrypoint's private copy of the password file, taken when the container started. */
  static readonly ACCOUNTS_STARTED_PASSWORD = '/run/sulla-accounts-private/database.password';
  static readonly DEFAULT_TIMINGS: PostgresAuthConsumerTimings = { perServiceMs: 45_000, pollMs: 2_000, accountsRestartSec: 120 };

  /** Every consumer's own database URL, in the order they are checked. */
  static readonly DATABASE_URLS: readonly ConsumerDatabaseUrl[] = [
    { target: ComposePostgresAuthConsumers.SECRET_CONSUMERS[0], source: 'env', ref: 'SULLA_VAULT_DATABASE_URL' },
    { target: ComposePostgresAuthConsumers.SECRET_CONSUMERS[1], source: 'env', ref: 'SULLA_DATABASE_URL' },
    { target: ComposePostgresAuthConsumers.SECRET_CONSUMERS[2], source: 'env', ref: 'SULLA_DATABASE_URL' },
    { target: ComposePostgresAuthConsumers.SECRET_CONSUMERS[3], source: 'env', ref: 'SULLA_FILES_DATABASE_URL' },
    { target: ComposePostgresAuthConsumers.ACCOUNTS, source: 'file', ref: '/run/sulla-accounts-private/database.url' },
  ];

  /**
   * Runs in the consumer with its own `pg` (every consumer image ships pg 8.18
   * and Node; `node -e` resolves modules from the working directory).
   * argv: <env|file> <name or path>. Prints only an error code; exit 0 = logged in.
   */
  static readonly FRESH_LOGIN_SCRIPT = [
    "const [source, ref] = process.argv.slice(1);",
    "let url = '';",
    "try { url = source === 'file' ? require('fs').readFileSync(ref, 'utf8').trim() : (process.env[ref] || ''); } catch {}",
    "if (!url) { process.stdout.write('NO_URL'); process.exit(2); }",
    "const client = new (require('pg').Client)({ connectionString: url, connectionTimeoutMillis: 5000 });",
    "client.connect().then(() => client.query('select 1')).then(() => client.end()).then(",
    "  () => process.exit(0),",
    "  error => { process.stdout.write(String((error && error.code) || 'ERROR')); process.exit(1); });",
  ].join('\n');
  private static readonly AUTH_FAILED = '28P01';

  constructor(
    /** Must not log command input or output. */
    private readonly docker: StdinDockerCli,
    private readonly drift: DriftStatusSource,
    /** Host path of the Accounts `database.password` value store. */
    private readonly accountsPasswordFile: string,
    private readonly waitServiceHealthy: ServiceHealthWait,
    private readonly logger: PostgresAuthLogger = console,
    private readonly timings: PostgresAuthConsumerTimings = ComposePostgresAuthConsumers.DEFAULT_TIMINGS,
    private readonly readFile: (file: string) => Promise<Buffer> = file => fs.readFile(file),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  async driftedConsumers(): Promise<string[]> {
    const drifted: string[] = [];

    for (const target of ComposePostgresAuthConsumers.SECRET_CONSUMERS) {
      const status = await this.drift.status(target);

      if (status === 'drifted' || status === 'unknown') {
        drifted.push(target.service);
      }
    }

    return drifted;
  }

  async accountsCurrent(): Promise<boolean> {
    const accounts = ComposePostgresAuthConsumers.ACCOUNTS;

    // Not running: it reads the current file whenever it next starts.
    if (!await this.isRunning(accounts.container) || await this.accountsPasswordMatches()) {
      return true;
    }
    this.logger.log('[PostgresAuth] restarting sulla_accounts: its database password changed after it started');
    const restart = await this.docker.run(['restart', accounts.container]);

    if (restart.code !== 0) {
      throw new Error('sulla_accounts could not be restarted');
    }
    await this.waitServiceHealthy(accounts, this.timings.accountsRestartSec);

    return this.accountsPasswordMatches();
  }

  /** accountsCurrent() for the secret-change path: never throws. */
  async refreshAccounts(): Promise<boolean> {
    try {
      return await this.accountsCurrent();
    } catch (error) {
      this.logger.warn(`[PostgresAuth] sulla_accounts did not pick up the new database password: ${ ComposePostgresAuthConsumers.firstLine(error) }`);

      return false;
    }
  }

  async waitHealthy(): Promise<void> {
    for (const consumer of ComposePostgresAuthConsumers.DATABASE_URLS) {
      if (await this.isRunning(consumer.target.container)) {
        await this.waitLoggedIn(consumer);
      }
    }
  }

  private async waitLoggedIn(consumer: ConsumerDatabaseUrl): Promise<void> {
    const deadline = this.now() + this.timings.perServiceMs;
    let last = 'no answer';

    for (;;) {
      last = await this.freshLogin(consumer);
      if (last === 'ok') {
        return;
      }
      if (last === ComposePostgresAuthConsumers.AUTH_FAILED) {
        throw new Error(`${ consumer.target.service } could not authenticate (${ last })`);
      }
      if (this.now() >= deadline) {
        throw new Error(`${ consumer.target.service } could not open a database connection (${ last })`);
      }
      await this.sleep(this.timings.pollMs);
    }
  }

  /** 'ok', or the short error code the script printed. */
  private async freshLogin(consumer: ConsumerDatabaseUrl): Promise<string> {
    const user = consumer.source === 'file' ? ['-u', '0'] : [];

    try {
      const result = await this.docker.run([
        'exec', ...user, consumer.target.container, 'node', '-e', ComposePostgresAuthConsumers.FRESH_LOGIN_SCRIPT, consumer.source, consumer.ref,
      ]);

      if (result.code === 0) {
        return 'ok';
      }
      const code = result.stdout.trim();

      return /^[A-Z0-9_]{1,32}$/.test(code) ? code : `exit ${ result.code }`;
    } catch {
      return 'timeout';
    }
  }

  private async isRunning(container: string): Promise<boolean> {
    const result = await this.docker.run(['inspect', '--format', '{{.State.Running}}', container]);

    return result.code === 0 && result.stdout.trim() === 'true';
  }

  private async accountsPasswordMatches(): Promise<boolean> {
    const expected = createHash('sha256').update(await this.readFile(this.accountsPasswordFile)).digest('hex');
    const result = await this.docker.run([
      'exec', '-u', '0', ComposePostgresAuthConsumers.ACCOUNTS.container, 'sha256sum', ComposePostgresAuthConsumers.ACCOUNTS_STARTED_PASSWORD,
    ]);

    return result.code === 0 && result.stdout.trim().split(/\s+/)[0] === expected;
  }

  private static firstLine(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
  }
}
