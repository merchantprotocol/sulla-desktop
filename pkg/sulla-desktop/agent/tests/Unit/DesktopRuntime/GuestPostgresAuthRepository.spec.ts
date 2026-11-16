// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { PostgresScramVerifier } from '@pkg/backend/PostgresScramVerifier';
import type { GuestDockerResult, StdinDockerCli } from '@pkg/backend/QuietGuestDockerStdin';
import { GuestPostgresAuthRepository } from '@pkg/backend/Repositories/GuestPostgresAuthRepository';

const SECRET = 'Kq3_real-ServiceSecret_value-9zXw7uVt2sRp1oNm0LkJi';
const PATH = '/var/lib/postgresql/data/pgdata/pg_hba.conf';

class RecordingDocker implements StdinDockerCli {
  readonly calls: { args: string[], input?: string }[] = [];
  result: GuestDockerResult = { code: 0, stdout: '', stderr: '' };

  async run(args: string[], input?: string): Promise<GuestDockerResult> {
    this.calls.push({ args, input });

    return this.result;
  }
}

function result(code: number, stdout = '', stderr = ''): GuestDockerResult {
  return { code, stdout, stderr };
}

describe('GuestPostgresAuthRepository', () => {
  // risk: secret exposure — the role password is set from a verifier on stdin, never the plaintext and never in argv
  it('sets the role password from a SCRAM verifier sent on stdin with statement logging off', async() => {
    const docker = new RecordingDocker();

    await new GuestPostgresAuthRepository(docker).setRolePassword(SECRET);

    const [call] = docker.calls;

    expect(call.args).toEqual(['exec', '-i', 'sulla_postgres', 'psql', '-U', 'sulla', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-tA', '-f', '-']);
    expect(call.input).not.toContain(SECRET);
    expect(call.input).toContain("SET LOCAL log_min_error_statement = 'panic';");
    const verifier = /ALTER ROLE sulla PASSWORD '([^']+)';/.exec(call.input ?? '')?.[1];

    expect(PostgresScramVerifier.parse(verifier)?.matches(SECRET)).toBe(true);
  });

  // risk: secret exposure — a failure message never carries psql output from the password statement
  it('reports a failed password change without psql output', async() => {
    const docker = new RecordingDocker();

    docker.result = result(3, '', "psql:<stdin>:4: ERROR:  ALTER ROLE sulla PASSWORD 'SCRAM-SHA-256$…'");

    await expect(new GuestPostgresAuthRepository(docker).setRolePassword(SECRET)).rejects.toThrow(/^setting the sulla role password failed \(exit 3\)$/);
  });

  // risk: secret exposure — the TCP probe reads its password from stdin inside the container
  it('probes over TCP with the password on stdin only', async() => {
    const docker = new RecordingDocker();

    docker.result = result(0, '1\n');
    expect(await new GuestPostgresAuthRepository(docker).probeTcp(SECRET)).toBe('ok');

    const [call] = docker.calls;

    expect(call.input).toBe(SECRET);
    expect(call.args.join(' ')).not.toContain(SECRET);
    expect(call.args.slice(0, 5)).toEqual(['exec', '-i', 'sulla_postgres', 'sh', '-c']);
    expect(call.args[5]).toContain('PGPASSWORD="$(cat)"');
    expect(call.args[5]).toContain('-h "$(hostname -i');
  });

  // risk: permissions — only 28P01 counts as "the wrong password was refused"
  it('classifies probe outcomes', () => {
    expect(GuestPostgresAuthRepository.probeOutcome(result(0, '1\n'))).toBe('ok');
    expect(GuestPostgresAuthRepository.probeOutcome(result(2, '', 'FATAL:  password authentication failed for user "sulla"'))).toBe('auth-failed');
    expect(GuestPostgresAuthRepository.probeOutcome(result(2, '', 'fe_sendauth: no password supplied'))).toBe('no-password');
    expect(GuestPostgresAuthRepository.probeOutcome(result(2, '', 'Connection refused'))).toBe('error');
    expect(GuestPostgresAuthRepository.probeOutcome(result(0, ''))).toBe('error');
  });

  // risk: availability — a probe whose Docker call throws is an error, never an exception into boot
  it('turns a Docker failure during a probe into an error outcome', async() => {
    const repository = new GuestPostgresAuthRepository({ run: () => Promise.reject(new Error('timeout')) });

    expect(await repository.probeTcp(SECRET)).toBe('error');
  });

  // risk: data accuracy — the hba file is replaced atomically as the postgres user
  it('writes the hba file as postgres through a temp file and rename, with the content on stdin', async() => {
    const docker = new RecordingDocker();

    await new GuestPostgresAuthRepository(docker).writeHbaFile(PATH, 'local all all trust\n');

    const [call] = docker.calls;

    expect(call.args.slice(0, 6)).toEqual(['exec', '-i', '-u', 'postgres', 'sulla_postgres', 'sh']);
    expect(call.args[7]).toBe('umask 077 && cat > "$1.sulla-tmp" && mv -f "$1.sulla-tmp" "$1"');
    expect(call.args.slice(-2)).toEqual(['sh', PATH]);
    expect(call.input).toBe('local all all trust\n');
  });

  // risk: data accuracy — the backup is written once and its absence is distinct from a failure
  it('reports whether the backup was created and reads a missing backup as null', async() => {
    const docker = new RecordingDocker();
    const repository = new GuestPostgresAuthRepository(docker);

    docker.result = result(0, 'created\n');
    expect(await repository.backupHbaOnce(PATH)).toBe(true);
    docker.result = result(0, 'exists\n');
    expect(await repository.backupHbaOnce(PATH)).toBe(false);
    expect(docker.calls[0].args[6]).toContain('if [ -e "$1.sulla-pre-scram" ]; then echo exists;');

    docker.result = result(3);
    expect(await repository.readHbaBackup(PATH)).toBeNull();
    docker.result = result(1, '', 'Permission denied');
    await expect(repository.readHbaBackup(PATH)).rejects.toThrow(/reading the hba backup failed \(exit 1\): Permission denied/);
  });

  // risk: outage — a reload that did not happen, or rule errors, are never mistaken for success
  it('reads rule errors line by line and fails a reload that does not return true', async() => {
    const docker = new RecordingDocker();
    const repository = new GuestPostgresAuthRepository(docker);

    docker.result = result(0, '3: invalid authentication method "x"\n4: missing database name\n');
    expect(await repository.hbaRuleErrors()).toEqual(['3: invalid authentication method "x"', '4: missing database name']);
    docker.result = result(0, '\n');
    expect(await repository.hbaRuleErrors()).toEqual([]);

    docker.result = result(0, 'f\n');
    await expect(repository.reload()).rejects.toThrow('pg_reload_conf() did not succeed');
    docker.result = result(0, 't\n');
    await expect(repository.reload()).resolves.toBeUndefined();
  });

  // risk: data accuracy — SHOW hba_file is the only trusted path
  it('rejects a hba_file answer that is not an absolute path', async() => {
    const docker = new RecordingDocker();

    docker.result = result(0, 'pg_hba.conf\n');
    await expect(new GuestPostgresAuthRepository(docker).hbaPath()).rejects.toThrow(/absolute/);
    docker.result = result(0, `${ PATH }\n`);
    expect(await new GuestPostgresAuthRepository(docker).hbaPath()).toBe(PATH);
  });

  // risk: permissions — the role name is interpolated into SQL, so only plain identifiers are accepted
  it('refuses a role name that is not a plain identifier', () => {
    expect(() => new GuestPostgresAuthRepository(new RecordingDocker(), 'sulla_postgres', "sulla'; DROP ROLE x; --")).toThrow(/unsupported/);
  });
});
