/** @jest-environment node */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { VAULT_TLS_DIRECTORY, vaultTlsBind } from '../vaultTlsIdentity';

const script = path.resolve('pkg/rancher-desktop/assets/scripts/provision-vault-tls');
const fixtures: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-vault-tls-test-'));
  fixtures.push(root);
  return { root, persistent: path.join(root, 'data', 'tls'), legacy: path.join(root, 'tmpfs', 'tls') };
}
function provision(persistent: string, legacy: string): string {
  return execFileSync('sh', [script, persistent, legacy, String(process.getuid!()), String(process.getgid!())], { encoding: 'utf8' });
}
function fingerprint(pem: string): string { return new crypto.X509Certificate(pem).fingerprint256 }
afterEach(() => { for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('persistent vault TLS identity', () => {
  test('survives tmpfs loss without changing the public identity or permissions', () => {
    const { persistent, legacy } = fixture();
    const first = provision(persistent, legacy);
    fs.mkdirSync(legacy, { recursive: true });
    fs.rmSync(path.dirname(legacy), { recursive: true }); // VM restart loses root tmpfs only.
    const second = provision(persistent, legacy);
    expect(fingerprint(second)).toBe(fingerprint(first));
    const certificate = new crypto.X509Certificate(second);
    expect(certificate.checkHost('sulla_vault')).toBe('sulla_vault');
    expect(certificate.checkHost('sulla-vault.local')).toBe('sulla-vault.local');
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(fs.statSync(persistent).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(persistent, 'tls.key')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(persistent, 'tls.crt')).mode & 0o777).toBe(0o644);
  });

  test('migrates a valid legacy identity while preserving its old mount', () => {
    const { persistent, legacy } = fixture();
    const old = provision(legacy, path.join(legacy, 'absent'));
    expect(fingerprint(provision(persistent, legacy))).toBe(fingerprint(old));
    expect(fs.existsSync(path.join(legacy, 'tls.key'))).toBe(true);
  });

  test('recovers empty Docker-created placeholders and ignores broken legacy identity', () => {
    const { persistent, legacy } = fixture();
    fs.mkdirSync(path.join(persistent, 'tls.crt'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'tls.crt'), { recursive: true });
    expect(new crypto.X509Certificate(provision(persistent, legacy)).ca).toBe(true);
    expect(fs.statSync(path.join(persistent, 'tls.crt')).isFile()).toBe(true);
  });

  test('replaces a mismatched certificate and key before publishing the public pin', () => {
    const { persistent, legacy } = fixture();
    provision(persistent, legacy);
    const unrelated = provision(legacy, path.join(legacy, 'absent'));
    fs.writeFileSync(path.join(persistent, 'tls.crt'), unrelated);
    fs.rmSync(legacy, { recursive: true });
    const repaired = provision(persistent, legacy);
    expect(fingerprint(repaired)).not.toBe(fingerprint(unrelated));
    expect(fingerprint(provision(persistent, legacy))).toBe(fingerprint(repaired));
  });

  test('replaces certificates that lack the required vault names', () => {
    const { persistent, legacy } = fixture();
    fs.mkdirSync(persistent, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=unrelated.local', '-keyout', path.join(persistent, 'tls.key'), '-out', path.join(persistent, 'tls.crt')], { stdio: 'ignore' });
    const incorrectFingerprint = fingerprint(fs.readFileSync(path.join(persistent, 'tls.crt'), 'utf8'));
    const repaired = provision(persistent, legacy);
    expect(fingerprint(repaired)).not.toBe(incorrectFingerprint);
    expect(new crypto.X509Certificate(repaired).checkHost('sulla_vault')).toBe('sulla_vault');
  });

  test('refuses nonempty placeholders and symlinks without deleting user data', () => {
    const { persistent, legacy, root } = fixture();
    fs.mkdirSync(path.join(persistent, 'tls.crt'), { recursive: true });
    const unexpected = path.join(persistent, 'tls.crt', 'keep');
    fs.writeFileSync(unexpected, 'preserve me');
    const args = [script, persistent, legacy, String(process.getuid!()), String(process.getgid!())];
    expect(spawnSync('sh', args).status).not.toBe(0);
    expect(fs.readFileSync(unexpected, 'utf8')).toBe('preserve me');
    fs.rmSync(persistent, { recursive: true });
    fs.symlinkSync(root, persistent);
    expect(spawnSync('sh', args).status).not.toBe(0);
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  test('mounts persistent sources read-only and disallows Docker placeholder creation', () => {
    expect(VAULT_TLS_DIRECTORY.startsWith('/mnt/data/')).toBe(true);
    expect(vaultTlsBind()).toEqual({
      type: 'bind', source: VAULT_TLS_DIRECTORY, target: '/run/sulla-vault-tls', read_only: true, bind: { create_host_path: false },
    });
    expect(vaultTlsBind(true)).toEqual({
      type: 'bind', source: `${ VAULT_TLS_DIRECTORY }/tls.crt`, target: '/run/sulla-vault-ca/tls.crt', read_only: true, bind: { create_host_path: false },
    });
  });
});
