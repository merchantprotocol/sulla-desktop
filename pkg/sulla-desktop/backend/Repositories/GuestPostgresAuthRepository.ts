// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PostgresScramVerifier } from '../PostgresScramVerifier';
import type { GuestDockerResult, StdinDockerCli } from '../QuietGuestDockerStdin';

/**
 * How a TCP login attempt ended:
 * - `ok`: authenticated and ran `SELECT 1`;
 * - `auth-failed`: the server refused the password (SQLSTATE 28P01);
 * - `no-password`: the server asked for a password and none was given;
 * - `error`: anything else (server unreachable, Docker failed).
 */
export type PostgresProbeOutcome = 'ok' | 'auth-failed' | 'no-password' | 'error';

/**
 * Every guest call the PostgreSQL auth hardening makes, as `docker exec` into
 * the PostgreSQL container. SQL runs over the container's local socket, which
 * stays `trust`, so these calls work before, during and after the switch.
 *
 * Secret handling: the service secret is never put in argv. The role password
 * is set from a SCRAM verifier computed in Node and sent as SQL on stdin; the
 * TCP probe reads its password from stdin into PGPASSWORD inside the container.
 * The runner must not log output (the role verifier is read through it).
 */
export class GuestPostgresAuthRepository {
  /** Suffix of the one-time copy of the hba file taken before the first managed write. */
  static readonly BACKUP_SUFFIX = '.sulla-pre-scram';
  private static readonly TEMP_SUFFIX = '.sulla-tmp';
  private static readonly ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

  constructor(
    /** Must not log command input or output. */
    private readonly docker: StdinDockerCli,
    private readonly container = 'sulla_postgres',
    private readonly role = 'sulla',
    private readonly database = 'postgres',
  ) {
    if (!GuestPostgresAuthRepository.ROLE_NAME.test(role)) {
      throw new Error(`unsupported PostgreSQL role name "${ role }"`);
    }
  }

  /**
   * Sets the role password to the secret's SCRAM verifier. The SQL goes on stdin;
   * statement logging is switched off for the transaction so a failure never
   * echoes the statement into the server log.
   */
  async setRolePassword(secret: string): Promise<void> {
    const verifier = PostgresScramVerifier.create(secret).toString();
    const sql = [
      'BEGIN;',
      "SET LOCAL log_statement = 'none';",
      "SET LOCAL log_min_error_statement = 'panic';",
      `ALTER ROLE ${ this.role } PASSWORD '${ verifier }';`,
      'COMMIT;',
      '',
    ].join('\n');
    const result = await this.docker.run(['exec', '-i', this.container, ...this.psql(), '-f', '-'], sql);

    if (result.code !== 0) {
      // stderr is left out on purpose: nothing from this statement goes to a log.
      throw new Error(`setting the ${ this.role } role password failed (exit ${ result.code ?? 'signal' })`);
    }
  }

  /** The role's stored password verifier (pg_authid.rolpassword); null when it has none. */
  async roleVerifier(): Promise<string | null> {
    const value = await this.query(`SELECT coalesce(rolpassword, '') FROM pg_authid WHERE rolname = '${ this.role }'`);

    return value.length > 0 ? value : null;
  }

  /** The hba file the server reads (`SHOW hba_file`). */
  async hbaPath(): Promise<string> {
    const path = await this.query('SHOW hba_file');

    if (!path.startsWith('/')) {
      throw new Error('PostgreSQL did not report an absolute hba_file path');
    }

    return path;
  }

  async readHbaFile(path: string): Promise<string> {
    return this.check(await this.docker.run(['exec', '-u', 'postgres', this.container, 'cat', '--', path]), 'reading the hba file').stdout;
  }

  /**
   * Replaces the hba file atomically and durably as the postgres user: owner-only
   * temp file, flushed to disk, renamed, and the rename flushed (busybox `sync`).
   */
  async writeHbaFile(path: string, content: string): Promise<void> {
    const temp = GuestPostgresAuthRepository.TEMP_SUFFIX;

    this.check(await this.docker.run(['exec', '-i', '-u', 'postgres', this.container, 'sh', '-c',
      `umask 077 && cat > "$1${ temp }" && sync && mv -f "$1${ temp }" "$1" && sync`, 'sh', path], content), 'writing the hba file');
  }

  /**
   * True when the server loaded the hba file after its last change: the file's
   * mtime (whole seconds) is before the second of the last configuration load.
   * Same-second edits count as not loaded, so a doubt never reads as "live".
   */
  async hbaFileLoaded(path: string): Promise<boolean> {
    const literal = path.split("'").join("''");

    return await this.query(
      `SELECT (pg_stat_file('${ literal }')).modification < date_trunc('second', pg_conf_load_time())`,
    ) === 't';
  }

  /** Copies the hba file to `<path>.sulla-pre-scram` unless that copy exists. True when it was created now. */
  async backupHbaOnce(path: string): Promise<boolean> {
    const backup = GuestPostgresAuthRepository.BACKUP_SUFFIX;
    const result = this.check(await this.docker.run(['exec', '-u', 'postgres', this.container, 'sh', '-c',
      `if [ -e "$1${ backup }" ]; then echo exists; else cp -p "$1" "$1${ backup }.tmp" && mv -f "$1${ backup }.tmp" "$1${ backup }" && echo created; fi`,
      'sh', path]), 'backing up the hba file');

    return result.stdout.trim() === 'created';
  }

  /** The one-time backup's content; null when there is none. */
  async readHbaBackup(path: string): Promise<string | null> {
    const backup = GuestPostgresAuthRepository.BACKUP_SUFFIX;
    const result = await this.docker.run(['exec', '-u', 'postgres', this.container, 'sh', '-c',
      `if [ -e "$1${ backup }" ]; then cat "$1${ backup }"; else exit 3; fi`, 'sh', path]);

    if (result.code === 3) {
      return null;
    }

    return this.check(result, 'reading the hba backup').stdout;
  }

  /** Parse errors in the hba file on disk (pg_hba_file_rules reads the file, not the loaded rules). */
  async hbaRuleErrors(): Promise<string[]> {
    const output = await this.query("SELECT coalesce(line_number::text, '?') || ': ' || error FROM pg_hba_file_rules WHERE error IS NOT NULL ORDER BY line_number");

    return output.split('\n').map(line => line.trim()).filter(Boolean);
  }

  /** Signals the server to reread its configuration (`pg_reload_conf()`). */
  async reload(): Promise<void> {
    if (await this.query('SELECT pg_reload_conf()') !== 't') {
      throw new Error('pg_reload_conf() did not succeed');
    }
  }

  /**
   * Logs in over TCP to the container's own address (so the `host` rule is the
   * one checked) with the given password, read from stdin into PGPASSWORD.
   */
  async probeTcp(password: string): Promise<PostgresProbeOutcome> {
    const script = 'PGPASSWORD="$(cat)"; export PGPASSWORD; PGCONNECT_TIMEOUT=5; export PGCONNECT_TIMEOUT; '
      + 'exec psql -h "$(hostname -i | awk \'{print $1}\')" -U "$1" -d "$2" -w -X -tAc \'SELECT 1\'';
    let result: GuestDockerResult;

    try {
      result = await this.docker.run(['exec', '-i', this.container, 'sh', '-c', script, 'sh', this.role, this.database], password);
    } catch {
      return 'error';
    }

    return GuestPostgresAuthRepository.probeOutcome(result);
  }

  static probeOutcome(result: GuestDockerResult): PostgresProbeOutcome {
    if (result.code === 0 && result.stdout.trim() === '1') {
      return 'ok';
    }
    if (/password authentication failed/i.test(result.stderr)) {
      return 'auth-failed';
    }
    if (/no password supplied/i.test(result.stderr)) {
      return 'no-password';
    }

    return 'error';
  }

  private psql(): string[] {
    return ['psql', '-U', this.role, '-d', this.database, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-tA'];
  }

  private async query(sql: string): Promise<string> {
    const result = this.check(await this.docker.run(['exec', this.container, ...this.psql(), '-c', sql]), 'psql');

    return result.stdout.replace(/\r?\n$/, '').trim();
  }

  private check(result: GuestDockerResult, step: string): GuestDockerResult {
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n')[0] ?? '';

      throw new Error(`${ step } failed (exit ${ result.code ?? 'signal' })${ reason ? `: ${ reason }` : '' }`);
    }

    return result;
  }
}
