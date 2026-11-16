// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Shared fakes for the PostgreSQL auth hardening specs (not a spec itself).

import { PostgresScramVerifier } from '@pkg/backend/PostgresScramVerifier';
import type { GuestDockerResult, StdinDockerCli } from '@pkg/backend/QuietGuestDockerStdin';

export const SECRET = 'Kq3_real-ServiceSecret_value-9zXw7uVt2sRp1oNm0LkJi';
export const DEV_PASSWORD = 'sulla_dev_password';
export const WRONG_PASSWORD = 'a-wrong-password-for-the-probe';
export const HBA_PATH = '/var/lib/postgresql/data/pgdata/pg_hba.conf';
/** What docker-library's entrypoint leaves behind with POSTGRES_HOST_AUTH_METHOD=trust. */
export const TRUST_INSTALL_HBA = 'local all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\nhost all all all trust\n';

function ok(stdout = ''): GuestDockerResult {
  return { code: 0, stdout, stderr: '' };
}

export const HEALTH_TIMEOUT_MS = 30_000;

/**
 * A fake clock in milliseconds. Sleeps advance it at once (and are traced as
 * `sleep:<ms>` events); the health bound never fires unless `healthExpired`.
 */
export class FakeClock {
  readonly sleeps: number[] = [];
  readonly healthSignals: (AbortSignal | undefined)[] = [];
  healthExpired = false;
  /** Starts on a whole second, so a run of fast docker calls stays inside one second. */
  now = 1_794_000_000_000;

  constructor(private readonly events: string[]) {}

  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    this.sleeps.push(ms);
    if (ms === HEALTH_TIMEOUT_MS) {
      this.healthSignals.push(signal);

      return this.healthExpired ? Promise.resolve() : new Promise(() => undefined);
    }
    this.events.push(`sleep:${ ms }`);
    this.now += ms;

    return Promise.resolve();
  };

  second(): number {
    return Math.floor(this.now / 1000);
  }
}

/**
 * Just enough of `docker exec sulla_postgres …` to behave like PostgreSQL 16:
 * psql over the local socket (always trusted), the hba file on disk versus the
 * rules loaded at the last reload, the role's SCRAM verifier, and TCP logins
 * that honour the loaded rules. Records every argv, stdin and step in order.
 *
 * Time: every docker call takes 10 ms of the fake clock. Like pg_stat_file, the
 * file's mtime is kept in whole seconds, and "loaded" (the repository's
 * hbaFileLoaded query) is true only when the mtime second is before the second
 * of the last configuration load.
 */
export class FakeGuestPostgres implements StdinDockerCli {
  private content = TRUST_INSTALL_HBA;
  /** Whole-second mtime of the hba file. */
  mtimeSecond: number;
  /** Whole second of the last configuration load (pg_conf_load_time). */
  loadSecond: number;
  loaded = TRUST_INSTALL_HBA;
  backup: string | null = null;
  verifier: string | null = null;
  ruleErrors: string[] = [];
  failWrite = false;
  /** A broken server that accepts any password even under scram. */
  acceptsAnyPassword = false;
  /** The secret is refused over TCP even though the verifier matches (e.g. a stale hostssl rule). */
  refusesSecret = false;
  /** TCP is unreachable. */
  tcpDown = false;
  /** How many of the next TCP probes end in a transient 'error' (a docker exec timeout). */
  probeErrors = 0;
  /** How many TCP probes after the next reload still see the old rules (pg_reload_conf is an async SIGHUP). */
  reloadLag = 0;
  private pending: string | null = null;
  readonly calls: { args: string[], input?: string }[] = [];

  constructor(readonly events: string[], private readonly clock: FakeClock) {
    this.mtimeSecond = clock.second() - 60;
    this.loadSecond = clock.second() - 30;
  }

  get hba(): string {
    return this.content;
  }

  set hba(content: string) {
    this.content = content;
    this.mtimeSecond = this.clock.second();
  }

  async run(args: string[], input?: string): Promise<GuestDockerResult> {
    this.clock.now += 10;
    this.calls.push({ args, input });
    if (args.includes('psql')) {
      return this.psql(args, input);
    }
    if (args.includes('cat')) {
      return ok(this.hba);
    }
    const script = args[args.indexOf('-c') + 1] ?? '';

    if (script.includes('PGPASSWORD')) {
      return this.probe(input ?? '');
    }
    if (script.includes('cat >')) {
      this.events.push('write');
      if (this.failWrite) {
        return { code: 1, stdout: '', stderr: 'mv: cannot move: Read-only file system' };
      }
      this.hba = input ?? '';

      return ok();
    }
    if (script.includes('echo created')) {
      this.events.push('backup');
      if (this.backup !== null) {
        return ok('exists\n');
      }
      this.backup = this.hba;

      return ok('created\n');
    }
    if (script.includes('exit 3')) {
      return this.backup === null ? { code: 3, stdout: '', stderr: '' } : ok(this.backup);
    }
    throw new Error(`unexpected docker ${ args.join(' ') }`);
  }

  private psql(args: string[], input?: string): GuestDockerResult {
    if (args.includes('-f')) {
      this.events.push('alter-role');
      this.verifier = /PASSWORD '([^']+)'/.exec(input ?? '')?.[1] ?? null;

      return ok();
    }
    const sql = args[args.indexOf('-c') + 1];

    if (sql === 'SHOW hba_file') return ok(`${ HBA_PATH }\n`);
    if (sql.includes('pg_authid')) return ok(`${ this.verifier ?? '' }\n`);
    if (sql.includes('pg_hba_file_rules')) {
      this.events.push('rules');

      return ok(this.ruleErrors.map(line => `${ line }\n`).join(''));
    }
    if (sql.includes('pg_reload_conf')) {
      this.events.push('reload');
      if (this.reloadLag > 0) {
        this.pending = this.hba;
      } else {
        this.loaded = this.hba;
        this.loadSecond = this.clock.second();
      }

      return ok('t\n');
    }
    if (sql.includes('pg_conf_load_time')) {
      this.events.push('loaded?');

      return ok(this.loaded === this.hba && this.mtimeSecond < this.loadSecond ? 't\n' : 'f\n');
    }
    throw new Error(`unexpected SQL ${ sql }`);
  }

  private probe(password: string): GuestDockerResult {
    this.events.push('probe');
    if (this.pending !== null) {
      if (this.reloadLag > 0) {
        this.reloadLag--;
      } else {
        this.loaded = this.pending;
        this.loadSecond = this.clock.second();
        this.pending = null;
      }
    }
    if (this.probeErrors > 0) {
      this.probeErrors--;

      return { code: 1, stdout: '', stderr: 'docker exec timed out' };
    }
    if (this.tcpDown) {
      return { code: 2, stdout: '', stderr: 'psql: error: connection to server at "172.18.0.2", port 5432 failed: Connection refused' };
    }
    const scram = /^host\s+all\s+all\s+all\s+scram-sha-256$/m.test(this.loaded);
    const matches = PostgresScramVerifier.parse(this.verifier)?.matches(password) ?? false;

    if (!scram || this.acceptsAnyPassword || (matches && !this.refusesSecret)) {
      return ok('1\n');
    }

    return { code: 2, stdout: '', stderr: 'psql: error: connection to server at "172.18.0.2", port 5432 failed: FATAL:  password authentication failed for user "sulla"' };
  }
}
