/**
 * Loss-protection tests: snapshots must be ciphertext-only, self-contained,
 * and restorable after total loss of the machine's vault files and database.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const keychain = { available: true };

jest.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString:         (s: string) => Buffer.from(`KC:${ s }`),
    decryptString:         (b: Buffer) => b.toString().slice(3),
  },
}), { virtual: true });
jest.mock('@pkg/utils/paths', () => ({ __esModule: true, default: { sullaConfig: '/nonexistent' } }));

// eslint-disable-next-line import/first
import {
  SnapshotNeedsSecretError, VaultBackupService, selectSnapshotsToKeep,
  type RestoreMode, type RestoreResult, type VaultRow, type VaultRowStore,
} from '../VaultBackupService';
// eslint-disable-next-line import/first
import { VaultKeyService } from '../VaultKeyService';

const PW = 'master password';

class MemoryStore implements VaultRowStore {
  rows = new Map<string, VaultRow>();
  failNextApply = false;

  static key(r: VaultRow) {
    return `${ r.integration_id }\u0000${ r.account_id }\u0000${ r.property }`;
  }

  async listRows() {
    return [...this.rows.values()].map(r => ({ ...r }));
  }

  async applyRows(rows: VaultRow[], mode: RestoreMode): Promise<RestoreResult> {
    const next = new Map(this.rows);
    const res = { inserted: 0, updated: 0, skipped: 0 };

    rows.forEach((r, i) => {
      if (this.failNextApply && i === Math.floor(rows.length / 2)) throw new Error('db died mid-restore');
      const k = MemoryStore.key(r);

      if (!next.has(k)) {
        next.set(k, { ...r });
        res.inserted++;
      } else if (mode === 'overwrite') {
        next.set(k, { ...next.get(k)!, value: r.value });
        res.updated++;
      } else {
        res.skipped++;
      }
    });
    this.rows = next; // commit only after every row applied (transaction)

    return res;
  }

  put(vault: VaultKeyService, integration_id: string, account_id: string, property: string, plaintext: string, encrypt = true) {
    const r = { integration_id, account_id, property, value: encrypt ? vault.encrypt(plaintext) : plaintext, is_default: false };

    this.rows.set(MemoryStore.key(r), r);
  }

  plain(vault: VaultKeyService): Record<string, string> {
    const out: Record<string, string> = {};

    for (const r of this.rows.values()) out[`${ r.integration_id }/${ r.account_id }/${ r.property }`] = vault.decrypt(r.value);

    return out;
  }
}

const created: VaultBackupService[] = [];

afterAll(() => created.forEach(b => b.stop()));

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-bk-'));
}

async function machine() {
  const home = tmp();
  const vault = new VaultKeyService(path.join(home, 'keys'));

  fs.mkdirSync(path.join(home, 'keys'));
  const { recoveryKey } = await vault.setupFromMasterPassword(PW);
  const store = new MemoryStore();
  const backups = new VaultBackupService(store, vault, path.join(home, 'backups'));

  created.push(backups);

  return { home, vault, store, backups, recoveryKey };
}

function seed(m: Awaited<ReturnType<typeof machine>>, n: number) {
  for (let i = 0; i < n; i++) {
    m.store.put(m.vault, 'website', `site_${ i }`, 'username', `user${ i }@example.com`);
    m.store.put(m.vault, 'website', `site_${ i }`, 'password', `P@ss-${ i }-${ 'ü'.repeat(i % 7) }`);
  }
}

beforeEach(() => {
  keychain.available = true;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('snapshots contain no plaintext, even for rows stored before encryption', async() => {
  const m = await machine();

  seed(m, 20);
  m.store.put(m.vault, 'legacy', 'default', 'api_key', 'PLAINTEXT-API-KEY', false);
  const file = (await m.backups.createSnapshot('test'))!;
  const body = fs.readFileSync(file, 'utf8');

  expect(body).not.toContain('PLAINTEXT-API-KEY');
  expect(body).not.toContain('P@ss-');
  expect(body).not.toContain('user3@example.com');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(body).rowCount).toBe(41);
});

it('skips identical snapshots and records every change', async() => {
  const m = await machine();

  seed(m, 3);
  expect(await m.backups.createSnapshot('a')).not.toBeNull();
  expect(await m.backups.createSnapshot('b')).toBeNull();
  m.store.put(m.vault, 'github', 'default', 'token', 'ghp_x');
  await new Promise(r => setTimeout(r, 5)); // distinct timestamp
  expect(await m.backups.createSnapshot('c')).not.toBeNull();
  expect(m.backups.listSnapshots()).toHaveLength(2);
});

it('concurrent snapshot requests serialize without corrupting files', async() => {
  const m = await machine();

  seed(m, 50);
  await Promise.all(Array.from({ length: 25 }, (_, i) => m.backups.createSnapshot(`burst-${ i }`)));
  for (const f of m.backups.listSnapshots()) {
    expect(() => JSON.parse(fs.readFileSync(path.join(m.backups.backupDir, f), 'utf8'))).not.toThrow();
  }
  expect(m.backups.listSnapshots()).toHaveLength(1);
});

it('does nothing while locked', async() => {
  const m = await machine();

  seed(m, 1);
  m.vault.lock();
  expect(await m.backups.createSnapshot('locked')).toBeNull();
});

it('DISASTER DRILL: VM + ~/.sulla wiped, new vault, restore everything with the recovery key', async() => {
  const old = await machine();

  seed(old, 200);
  const expected = old.store.plain(old.vault);
  const snapFile = (await old.backups.createSnapshot('before disaster'))!;
  const snapshot = JSON.parse(fs.readFileSync(snapFile, 'utf8'));

  // Total loss: the old key files and database are gone. User reinstalls,
  // sets up a brand-new vault with a different password.
  fs.rmSync(path.join(old.home, 'keys'), { recursive: true });
  const fresh = await machine();

  await expect(fresh.backups.restoreSnapshot(snapshot)).rejects.toBeInstanceOf(SnapshotNeedsSecretError);
  await expect(fresh.backups.restoreSnapshot(snapshot, { password: 'nope' })).rejects.toThrow('VAULT_WRONG_PASSWORD');
  expect(fresh.store.rows.size).toBe(0);

  const res = await fresh.backups.restoreSnapshot(snapshot, { recoveryKey: old.recoveryKey });

  expect(res).toMatchObject({ inserted: 400, skipped: 0, unreadable: 0 });
  expect(fresh.store.plain(fresh.vault)).toEqual(expected); // re-encrypted under the NEW key
});

it('restores with the old master password too, and after a password change on the same machine', async() => {
  const m = await machine();

  seed(m, 10);
  const snapshot = JSON.parse(fs.readFileSync((await m.backups.createSnapshot('x'))!, 'utf8'));
  const expected = m.store.plain(m.vault);

  await m.vault.changePassword(PW, 'new one');
  m.store.rows.clear();
  // Same VMK → no secret needed even though the password changed.
  await m.backups.restoreSnapshot(snapshot);
  expect(m.store.plain(m.vault)).toEqual(expected);

  const other = await machine();

  await other.backups.restoreSnapshot(snapshot, { password: PW });
  expect(other.store.plain(other.vault)).toEqual(expected);
});

it('merge never clobbers newer values; overwrite does', async() => {
  const m = await machine();

  m.store.put(m.vault, 'website', 'a', 'password', 'old');
  const snapshot = JSON.parse(fs.readFileSync((await m.backups.createSnapshot('x'))!, 'utf8'));

  m.store.put(m.vault, 'website', 'a', 'password', 'newer');
  expect(await m.backups.restoreSnapshot(snapshot)).toMatchObject({ inserted: 0, skipped: 1 });
  expect(m.store.plain(m.vault)['website/a/password']).toBe('newer');
  await m.backups.restoreSnapshot(snapshot, { mode: 'overwrite' });
  expect(m.store.plain(m.vault)['website/a/password']).toBe('old');
});

it('a failure mid-restore changes nothing, and a safety snapshot was taken first', async() => {
  const m = await machine();

  seed(m, 5);
  const snapshot = JSON.parse(fs.readFileSync((await m.backups.createSnapshot('x'))!, 'utf8'));
  const before = m.store.plain(m.vault);

  m.store.rows.delete([...m.store.rows.keys()][0]);
  const beforeRestore = m.store.plain(m.vault);

  m.store.failNextApply = true;
  await expect(m.backups.restoreSnapshot(snapshot)).rejects.toThrow('db died');
  expect(m.store.plain(m.vault)).toEqual(beforeRestore);
  expect(Object.keys(before).length).toBe(Object.keys(beforeRestore).length + 1);
  expect(m.backups.listSnapshots().length).toBeGreaterThanOrEqual(2); // pre-restore safety copy
});

it('rejects tampered snapshots and skips (reports) individually corrupt rows', async() => {
  const m = await machine();

  seed(m, 4);
  const snapshot = JSON.parse(fs.readFileSync((await m.backups.createSnapshot('x'))!, 'utf8'));
  const tampered = JSON.parse(JSON.stringify(snapshot));

  tampered.rows[0].value = m.vault.encrypt('attacker value');
  await expect(m.backups.restoreSnapshot(tampered)).rejects.toThrow('VAULT_SNAPSHOT_CORRUPT');

  const damaged = JSON.parse(JSON.stringify(snapshot));

  damaged.rows[0].value = '$VAULT$Zm9v';
  delete damaged.rowsSha256;
  m.store.rows.clear();
  expect(await m.backups.restoreSnapshot(damaged)).toMatchObject({ inserted: 7, unreadable: 1 });
});

it('retention keeps recent, daily and monthly snapshots so a burst cannot rotate out history', () => {
  const names: string[] = [];
  const start = Date.UTC(2025, 0, 1);

  for (let h = 0; h < 24 * 400; h += 3) {
    names.push(`vault-snapshot-${ new Date(start + h * 3600_000).toISOString().replace(/[-:.]/g, '') }.json`);
  }
  // then a burst of 500 snapshots in one minute
  for (let i = 0; i < 500; i++) {
    names.push(`vault-snapshot-${ new Date(start + 400 * 86400_000 + i * 100).toISOString().replace(/[-:.]/g, '') }.json`);
  }
  const keep = selectSnapshotsToKeep(names);
  const sorted = [...names].sort();

  expect(keep.size).toBeLessThanOrEqual(20 + 30 + 12);
  expect(keep.has(sorted[sorted.length - 1])).toBe(true);
  const months = new Set([...keep].map(n => n.slice(15, 21)));

  expect(months.size).toBeGreaterThanOrEqual(12); // a year of monthly history survives the burst
});

it('encrypted export is a self-contained snapshot', async() => {
  const m = await machine();

  seed(m, 3);
  const exported = JSON.parse(await m.backups.buildExport());
  const other = await machine();

  await other.backups.restoreSnapshot(exported, { password: PW });
  expect(other.store.plain(other.vault)).toEqual(m.store.plain(m.vault));
});
