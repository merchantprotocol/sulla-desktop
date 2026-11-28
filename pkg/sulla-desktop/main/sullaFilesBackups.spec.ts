// SPDX-License-Identifier: GPL-2.0-or-later
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Notification: class { static isSupported() { return false } show() {} } }));
vi.mock('./sullaFilesClient', () => ({ getSullaFilesClient: vi.fn() }));
vi.mock('./vaultTls', () => ({ VAULT_HTTPS_ORIGIN: 'https://127.0.0.1:30123' }));
vi.mock('@pkg/vault-broker/desktopTransport', () => ({ desktopVaultFetch: vi.fn(), loadDesktopApprovalIdentity: vi.fn() }));

import { SullaFilesBackups, type BackupVaultCredentials } from './sullaFilesBackups.ts';

import type { VMExecutor } from '@pkg/backend/backend';

const DESTINATION = '0b6d9f8e-4c7a-4f1e-9a2b-3c4d5e6f7a8b';
const ANCHOR_LINE = '36 35 98:0 /sulla-backups /mnt/sulla-backups rw,noatime shared:1 - ext4 /dev/root rw';

/** Records VM commands; answers mountinfo reads and captures stdin of spawned writers. */
class FakeExecutor {
  readonly commands:string[][] = [];
  readonly stdin:Buffer[] = [];
  constructor(public mountinfo = '') {}

  async execCommand(options:{ capture?: boolean }, ...command:string[]):Promise<string | void> {
    this.commands.push(command);
    if (options.capture && command.join(' ') === 'cat /proc/self/mountinfo') return this.mountinfo;
  }

  spawn(_options:unknown, ...command:string[]) {
    this.commands.push(command);
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end(payload:Buffer):void } };
    const stdin = new EventEmitter() as EventEmitter & { end(payload:Buffer):void };
    stdin.end = payload => {
      this.stdin.push(Buffer.from(payload));
      queueMicrotask(() => child.emit('exit', 0));
    };
    child.stdin = stdin;
    return child;
  }

  asVm():VMExecutor { return this as unknown as VMExecutor }
}

class FakeBackupClient {
  readonly calls:{ endpoint: string; init?: RequestInit }[] = [];
  state:unknown = { destinations: [], runtimeRequests: [] };
  async backupJson<T>(endpoint:string, init?:RequestInit):Promise<T> {
    this.calls.push({ endpoint, init });
    return (endpoint === '/v1/local/backups' ? this.state : undefined) as T;
  }
  reports() { return this.calls.filter(call => call.endpoint.startsWith('/v1/local/backups/runtime/')).map(call => JSON.parse(String(call.init?.body))) }
}

const settle = async() => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)) };

describe('SullaFilesBackups', () => {
  let client:FakeBackupClient;
  let alerts:{ firstFailure: ReturnType<typeof vi.fn> };
  let vault:BackupVaultCredentials & { fetch: ReturnType<typeof vi.fn> };
  let clock:number;
  let backups:SullaFilesBackups;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    client = new FakeBackupClient();
    alerts = { firstFailure: vi.fn(async() => undefined) };
    vault = {
      loadIdentity: vi.fn(async() => ({ serviceId: 'desktop', serviceToken: 'service-token' })),
      fetch:        vi.fn(async() => Response.json({ username: 'alice', password: 's3cret-pass' })),
    };
    clock = 1_000_000;
    backups = new SullaFilesBackups(() => client, alerts, vault, () => ({ uid: 501, gid: 20 }), () => clock);
  });
  afterEach(() => { vi.useRealTimers() });

  const poll = async(executor:FakeExecutor) => {
    backups.configureGuest(executor.asVm());
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
  };

  it('refuses to remove a destination with an invalid id', async() => {
    // risk: data integrity — a malformed id must never reach the Files delete endpoint.
    await expect(backups.remove('../all')).rejects.toThrow('Invalid backup destination');
    expect(client.calls).toHaveLength(0);
    await backups.remove(DESTINATION);
    expect(client.calls).toEqual([{ endpoint: `/v1/local/backups/destinations/${ DESTINATION }`, init: expect.objectContaining({ method: 'DELETE' }) }]);
  });

  it('creates the propagation anchor and hands it to the desktop user', async() => {
    // risk: file access control — the anchor must be rshared and owned 0700 by the desktop user.
    const executor = new FakeExecutor('');
    await backups.prepareAnchor(executor.asVm());
    expect(executor.commands).toEqual([
      ['install', '-d', '-m', '0755', '/mnt/sulla-backups'],
      ['cat', '/proc/self/mountinfo'],
      ['mount', '--bind', '/mnt/sulla-backups', '/mnt/sulla-backups'],
      ['mount', '--make-rshared', '/mnt/sulla-backups'],
      ['chown', '501:20', '/mnt/sulla-backups'],
      ['chmod', '0700', '/mnt/sulla-backups'],
    ]);
  });

  it('refuses an anchor that is itself a network mount', async() => {
    // risk: data integrity — chown/chmod must never run against a mounted NAS share.
    const executor = new FakeExecutor('40 35 0:50 / /mnt/sulla-backups rw shared:2 - cifs //nas/share rw');
    await expect(backups.prepareAnchor(executor.asVm())).rejects.toThrow('Unexpected backup propagation anchor');
    expect(executor.commands.some(command => command[0] === 'chown')).toBe(false);
  });

  it('mounts an NFS destination with hardened options and reports success', async() => {
    // risk: irreversible side effect — NAS mounts must be nosuid,nodev,noexec and the result reported once.
    client.state = {
      destinations:    [{ id: DESTINATION, kind: 'nas', label: 'NAS', config: { share: 'nfs://nas.local/volume1/backups', protocol: 'nfs' } }],
      runtimeRequests: [{ id: 'req-1', destinationId: DESTINATION, action: 'mount' }],
    };
    const executor = new FakeExecutor(ANCHOR_LINE);
    await poll(executor);
    expect(executor.commands).toContainEqual(['timeout', '-s', 'KILL', '60', 'mount', '-t', 'nfs', '-o', 'nosuid,nodev,noexec', 'nas.local:/volume1/backups', `/mnt/sulla-backups/nas-${ DESTINATION }`]);
    expect(client.reports()).toEqual([{ ok: true }]);
  });

  it('reports failure without mounting a share URL that carries credentials', async() => {
    // risk: secret exposure — credentials embedded in a share URL must never reach mount argv.
    client.state = {
      destinations:    [{ id: DESTINATION, kind: 'nas', label: 'NAS', config: { share: 'smb://bob:pw@nas.local/share', protocol: 'smb', vaultCredentialId: 'item' } }],
      runtimeRequests: [{ id: 'req-2', destinationId: DESTINATION, action: 'mount' }],
    };
    const executor = new FakeExecutor(ANCHOR_LINE);
    await poll(executor);
    expect(executor.commands.some(command => command.includes('mount') && command.includes('-t'))).toBe(false);
    expect(client.reports()).toEqual([{ ok: false }]);
  });

  it('sends SMB credentials over stdin only and always removes the credential file', async() => {
    // risk: secret exposure — the SMB password must never appear in VM argv and must not persist.
    client.state = {
      destinations:    [{ id: DESTINATION, kind: 'nas', label: 'NAS', config: { share: 'smb://nas.local/share', protocol: 'smb', vaultCredentialId: 'item-1' } }],
      runtimeRequests: [{ id: 'req-3', destinationId: DESTINATION, action: 'mount' }],
    };
    const executor = new FakeExecutor(ANCHOR_LINE);
    await poll(executor);
    expect(vault.fetch).toHaveBeenCalledWith('https://127.0.0.1:30123/v1/desktop/backup-credentials', expect.objectContaining({ body: JSON.stringify({ itemId: 'item-1', target: 'smb://nas.local/share' }) }));
    expect(executor.stdin.map(buffer => buffer.toString())).toEqual(['username=alice\npassword=s3cret-pass\n']);
    expect(executor.commands.flat().some(arg => arg.includes('s3cret-pass'))).toBe(false);
    const mount = executor.commands.find(command => command.includes('cifs'));
    const credentialFile = /credentials=([^,]+)/.exec(mount?.join(' ') ?? '')?.[1];
    expect(mount?.join(' ')).toContain(',uid=501,gid=20,');
    expect(executor.commands).toContainEqual(['rm', '-f', credentialFile]);
    expect(client.reports()).toEqual([{ ok: true }]);
  });

  it('does not mount when Vault refuses the SMB credential', async() => {
    // risk: data integrity — a missing credential must be reported as a failed mount, not a success.
    vault.fetch.mockResolvedValueOnce(new Response('', { status: 403 }));
    client.state = {
      destinations:    [{ id: DESTINATION, kind: 'nas', label: 'NAS', config: { share: 'smb://nas.local/share', protocol: 'smb', vaultCredentialId: 'item-1' } }],
      runtimeRequests: [{ id: 'req-4', destinationId: DESTINATION, action: 'mount' }],
    };
    const executor = new FakeExecutor(ANCHOR_LINE);
    await poll(executor);
    expect(executor.commands.some(command => command.includes('cifs'))).toBe(false);
    expect(client.reports()).toEqual([{ ok: false }]);
  });

  it('alerts once per failure episode and again after the destination recovers', async() => {
    // risk: notification spam or a silently missed backup failure.
    const failed = { destinations: [{ id: DESTINATION, kind: 'nas', label: 'Office NAS', config: {}, status: { state: 'failed' } }], runtimeRequests: [] };
    client.state = failed;
    const executor = new FakeExecutor(ANCHOR_LINE);
    await poll(executor);
    clock += 2 * 60_000;
    await poll(executor);
    expect(alerts.firstFailure).toHaveBeenCalledTimes(1);
    expect(alerts.firstFailure).toHaveBeenCalledWith({ destinationId: DESTINATION, message: 'Office NAS: check the destination and Vault credentials.' });
    client.state = { ...failed, destinations: [{ ...failed.destinations[0], status: { state: 'verified' } }] };
    clock += 2 * 60_000;
    await poll(executor);
    client.state = failed;
    clock += 2 * 60_000;
    await poll(executor);
    expect(alerts.firstFailure).toHaveBeenCalledTimes(2);
  });

  it('stops polling only when the configured guest is cleared', async() => {
    // risk: lifecycle — a stale backend must not stop the live guest's backup polling.
    const executor = new FakeExecutor(ANCHOR_LINE);
    await poll(executor);
    const before = client.calls.length;
    backups.clearGuest(new FakeExecutor().asVm());
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(client.calls.length).toBeGreaterThan(before);
    backups.clearGuest(executor.asVm());
    const after = client.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(client.calls.length).toBe(after);
  });
});
