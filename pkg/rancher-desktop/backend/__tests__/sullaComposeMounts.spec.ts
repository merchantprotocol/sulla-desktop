/** @jest-environment node */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  ACCOUNTS_SECRET_NAMES, ACCOUNTS_SECRETS_DIRECTORY, INSTALL_ACCOUNTS_SECRETS, accountsSecretBinds,
  findHostBindMounts, provisionAccountsSecretsInGuest,
} from '../sullaComposeMounts';
import { reconcileComposeService } from '../sullaServiceReconcile';

const fixtures: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-compose-mounts-'));

  fixtures.push(dir);

  return dir;
};

afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('host bind detection', () => {
  test('flags host, relative and home sources; allows named volumes and guest paths', () => {
    const found = findHostBindMounts({
      services: {
        a: {
          volumes: [
            'named:/data', '/data/anon', '/mnt/data/var/lib/sulla/x:/x:ro', '/var/lib/sulla/files-fuse:/f:ro',
            '/mnt/sulla-files:/mnt/sulla-files:rshared', '/var/run/docker.sock:/var/run/docker.sock',
            { type: 'volume', source: 'v' }, { type: 'bind', source: '/mnt/data/var/lib/sulla/files-tls' },
          ],
        },
        b: {
          volumes: [
            '/Users/me/sulla/files:/data/files', './local:/l', '~/x:/x', '{{sullaDataDir}}/pg:/pg',
            { type: 'bind', source: '/Volumes/disk/x' }, { type: 'bind', source: '/private/var/folders/x' },
          ],
        },
      },
    });

    expect(found).toEqual([
      { service: 'b', source: '/Users/me/sulla/files' },
      { service: 'b', source: './local' },
      { service: 'b', source: '~/x' },
      { service: 'b', source: '{{sullaDataDir}}/pg' },
      { service: 'b', source: '/Volumes/disk/x' },
      { service: 'b', source: '/private/var/folders/x' },
    ]);
  });

  test('accounts binds are read-only guest paths that compose never creates', () => {
    for (const bind of accountsSecretBinds()) {
      expect(bind.source.startsWith(`${ ACCOUNTS_SECRETS_DIRECTORY }/`)).toBe(true);
      expect(bind).toMatchObject({ type: 'bind', read_only: true, bind: { create_host_path: false } });
    }
    expect(accountsSecretBinds().map(b => b.target)).toEqual(
      ACCOUNTS_SECRET_NAMES.map(n => `/run/sulla-accounts-source/${ n }`));
  });
});

describe('accounts secret provisioning into the guest', () => {
  function hostSecrets() {
    const dir = tempDir();
    const files = {} as Record<typeof ACCOUNTS_SECRET_NAMES[number], string>;

    for (const name of ACCOUNTS_SECRET_NAMES) {
      files[name] = path.join(dir, name);
      fs.writeFileSync(files[name], Buffer.from(`value-of-${ name }\0\xff`, 'latin1'), { mode: 0o600 });
    }

    return files;
  }

  test('stages through a private temp dir, installs as root, and cleans up', async() => {
    const calls: { command: string[]; root: boolean }[] = [];
    const copies: [string, string][] = [];
    const files = hostSecrets();

    await provisionAccountsSecretsInGuest({
      run: (command, options) => {
        calls.push({ command, root: !!options?.root });

        return Promise.resolve(command[0] === 'mktemp' ? '/tmp/sulla-accounts-secrets.Ab12Cd\n' : '');
      },
      copyToGuest: (hostPath, guestPath) => { copies.push([hostPath, guestPath]); return Promise.resolve() },
    }, files);

    expect(calls[0]).toEqual({ command: ['mktemp', '-d', '/tmp/sulla-accounts-secrets.XXXXXX'], root: false });
    expect(copies).toEqual(ACCOUNTS_SECRET_NAMES.map(n => [files[n], `/tmp/sulla-accounts-secrets.Ab12Cd/${ n }`]));
    expect(calls[1]).toEqual({
      command: ['sh', '-c', INSTALL_ACCOUNTS_SECRETS, '--', ACCOUNTS_SECRETS_DIRECTORY,
        '/tmp/sulla-accounts-secrets.Ab12Cd', 'root', 'root', ...ACCOUNTS_SECRET_NAMES],
      root: true,
    });
    expect(calls[2]).toEqual({ command: ['rm', '-rf', '--', '/tmp/sulla-accounts-secrets.Ab12Cd'], root: true });
    // No secret value ever appears in a command line.
    const commandText = calls.map(c => c.command.join(' ')).join('\n');

    for (const name of ACCOUNTS_SECRET_NAMES) expect(commandText).not.toContain(`value-of-${ name }`);
  });

  test('the install script writes a 0700 directory of 0400 byte-identical files, idempotently', () => {
    const files = hostSecrets();
    const stage = tempDir();
    const dest = path.join(tempDir(), 'accounts-secrets');
    const owner = String(process.getuid!());
    const group = String(process.getgid!());

    for (const name of ACCOUNTS_SECRET_NAMES) fs.copyFileSync(files[name], path.join(stage, name));
    const install = () => execFileSync('sh', ['-c', INSTALL_ACCOUNTS_SECRETS, '--', dest, stage, owner, group, ...ACCOUNTS_SECRET_NAMES]);

    install();
    install(); // second generation over existing 0400 files

    expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dest).sort()).toEqual([...ACCOUNTS_SECRET_NAMES].sort());
    for (const name of ACCOUNTS_SECRET_NAMES) {
      expect(fs.statSync(path.join(dest, name)).mode & 0o777).toBe(0o400);
      expect(fs.readFileSync(path.join(dest, name)).equals(fs.readFileSync(files[name]))).toBe(true);
    }
  });

  test('refuses a symlinked destination', () => {
    const stage = tempDir();
    const root = tempDir();
    const dest = path.join(root, 'accounts-secrets');

    fs.symlinkSync(tempDir(), dest);
    expect(() => execFileSync('sh', ['-c', INSTALL_ACCOUNTS_SECRETS, '--', dest, stage, String(process.getuid!()),
      String(process.getgid!()), 'session.secret'], { stdio: 'pipe' })).toThrow();
  });

  test('always removes the staging directory, even when installation fails', async() => {
    const calls: string[][] = [];

    await expect(provisionAccountsSecretsInGuest({
      run: (command) => {
        calls.push(command);
        if (command[0] === 'sh') return Promise.reject(new Error('install failed'));

        return Promise.resolve('/tmp/sulla-accounts-secrets.Zz9\n');
      },
      copyToGuest: () => Promise.resolve(),
    }, hostSecrets())).rejects.toThrow('install failed');
    expect(calls.at(-1)).toEqual(['rm', '-rf', '--', '/tmp/sulla-accounts-secrets.Zz9']);
  });
});

describe('optional service reconciliation', () => {
  const composeCommand = ['docker', 'compose', '-f', '/tmp/sulla-docker-compose.yml', '-p', 'sulla'];
  const log = { warn: jest.fn() };

  test('a failed registry refresh still starts the service from the local image', async() => {
    const calls: string[][] = [];

    await reconcileComposeService({
      composeCommand,
      service:      'sulla_files',
      refreshImage: 'ghcr.io/merchantprotocol/sulla-files:latest',
      log,
      run:          (...command) => {
        calls.push(command);

        return command[1] === 'pull' ? Promise.reject(new Error('registry unreachable')) : Promise.resolve();
      },
    });
    expect(calls).toEqual([
      ['docker', 'pull', 'ghcr.io/merchantprotocol/sulla-files:latest'],
      [...composeCommand, 'up', '-d', '--no-deps', '--pull', 'never', 'sulla_files'],
    ]);
  });

  test('a container that cannot start as-is is recreated from the current definition', async() => {
    const calls: string[][] = [];

    await reconcileComposeService({
      composeCommand,
      service:      'sulla_files',
      refreshImage: 'img:latest',
      log,
      run:          (...command) => {
        calls.push(command);
        const isFirstUp = command.includes('up') && !command.includes('--force-recreate');

        return isFirstUp
          ? Promise.reject(new Error('bind source path does not exist: /Users/me/sulla/files'))
          : Promise.resolve();
      },
    });
    expect(calls.slice(1)).toEqual([
      [...composeCommand, 'up', '-d', '--no-deps', '--pull', 'never', 'sulla_files'],
      [...composeCommand, 'up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', 'sulla_files'],
    ]);
  });

  test('source builds and overrides are not pulled and keep compose defaults', async() => {
    const calls: string[][] = [];

    await reconcileComposeService({
      composeCommand, service: 'tools', log, run: (...command) => { calls.push(command); return Promise.resolve() },
    });
    expect(calls).toEqual([[...composeCommand, 'up', '-d', '--no-deps', 'tools']]);
  });

  test('cancellation propagates and stops further work', async() => {
    const run = jest.fn(() => Promise.resolve());
    let checks = 0;

    await expect(reconcileComposeService({
      composeCommand,
      service:      'x',
      refreshImage: 'i',
      log,
      run,
      checkpoint:   () => { if (++checks === 2) throw new Error('cancelled'); },
    })).rejects.toThrow('cancelled');
    expect(run).toHaveBeenCalledTimes(1); // the pull only
  });
});
