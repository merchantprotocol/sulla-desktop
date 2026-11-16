// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (S4a): Files key custody read/rotate path. A recording database captures every SQL
// statement VaultFilesKeyBundleAuthority issues, so the spec can assert that both the rotate
// path (registerBundle) and the read path (authorizeDeviceRecovery) run inside the
// per-collection advisory-lock transaction, read the current generation with FOR UPDATE, and
// scope every predicate to the requesting principal. It also pins that no key material is
// used once the Vault locks while a custody read is awaiting, and that opened bundle keys
// are zeroed.
//
// On main (before this change) the device-recovery cases fail: recovery read the envelope
// with a bare pool query (no transaction, no FOR UPDATE) and re-wrapped with the private key
// even after the Vault locked during that read.

import type { FilesCollectionKeyMaterial, FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';
import { describe, expect, it } from 'vitest';

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { VaultFilesKeyBundleAuthority } from '../../../../../../services/sulla-vault/src/filesKeyBundleAuthority';
import type { FilesKeyBundleCipher } from '../../../../../../services/sulla-vault/src/filesKeys/FilesKeyBundleCipher';
import { FilesKeyBundlePolicy } from '../../../../../../services/sulla-vault/src/filesKeys/FilesKeyBundlePolicy';
import type { FilesAuthorityIdentityLease, UnlockedFilesAuthorityIdentity } from '../../../../../../services/sulla-vault/src/filesKeys/FilesKeyBundleTypes';

const PRINCIPAL = 'principal-e10';
const COLLECTION = 'collection-e10';
const PUBLIC_KEY = 'vault-public-key-e10';
const CONTEXT: FilesKeyBundleContext = { principalId: PRINCIPAL, collectionId: COLLECTION, keyVersion: 3, epoch: 2 };

interface Statement { via: 'pool' | 'client'; sql: string; values?: unknown[] }

/** Records every statement, on the pool and on the transaction client, with whitespace collapsed. */
class RecordingDatabase {
  readonly log: Statement[] = [];
  private gate: Promise<void> | null = null;
  private onGate: (() => void) | null = null;

  constructor(private readonly rowsFor: (sql: string) => unknown[] = () => []) {}

  readonly client = {
    query:   (sql: string, values?: unknown[]) => this.record('client', sql, values),
    release: () => { this.log.push({ via: 'client', sql: 'release' }) },
  };

  query(sql: string, values?: unknown[]) { return this.record('pool', sql, values) }

  async connect() { return this.client }

  /** The next custody read waits on `gate`; `onGate` runs once it is waiting. */
  holdNextRead(gate: Promise<void>, onGate: () => void): void {
    this.gate = gate;
    this.onGate = onGate;
  }

  statements(): string[] { return this.log.map(entry => entry.sql) }

  private async record(via: Statement['via'], sql: string, values?: unknown[]) {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.log.push(values ? { via, sql: text, values } : { via, sql: text });
    if (this.gate && /authority_bundle/.test(text) && /^SELECT/.test(text)) {
      const gate = this.gate;
      this.gate = null;
      this.onGate?.();
      await gate;
    }
    const rows = this.rowsFor(text);
    return { rows, rowCount: rows.length };
  }
}

/** Lends an erasable private-key copy; `lock()` makes every later generation check fail. */
class SwitchableLease implements FilesAuthorityIdentityLease {
  locked = false;
  private readonly privateKey = new Uint8Array(32).fill(0x5a);

  lock(): void { this.locked = true }

  async withUnlockedIdentity<T>(operation: (identity: UnlockedFilesAuthorityIdentity) => Promise<T>): Promise<T> {
    if (this.locked) throw Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
    const copy = Uint8Array.from(this.privateKey);
    const assertCurrent = () => { if (this.locked) throw Object.assign(new Error('Vault locked during request'), { code: 'vault_locked' }) };
    try {
      const result = await operation({ principalId: PRINCIPAL, publicKey: PUBLIC_KEY, privateKey: copy, generation: 1, assertCurrent });
      assertCurrent();
      return result;
    } finally {
      copy.fill(0);
    }
  }
}

/** Records what reaches the crypto layer; opened material is kept so the spec can check it was zeroed. */
class RecordingCipher implements FilesKeyBundleCipher {
  readonly opened: FilesCollectionKeyMaterial[] = [];
  readonly rewrapKeys: Uint8Array[] = [];

  async open(): Promise<FilesCollectionKeyMaterial> {
    const material = { dataKey: new Uint8Array(32).fill(7), dedupKey: new Uint8Array(32).fill(8) } as FilesCollectionKeyMaterial;
    this.opened.push(material);
    return material;
  }

  async rewrapForDevice(_envelope: FilesKeyBundleEnvelope, context: FilesKeyBundleContext, _publicKey: string, privateKey: Uint8Array): Promise<FilesKeyBundleEnvelope> {
    this.rewrapKeys.push(Uint8Array.from(privateKey));
    return { version: 1, purpose: 'device-recovery', context } as unknown as FilesKeyBundleEnvelope;
  }
}

class CustodyFixture {
  readonly lease = new SwitchableLease();
  readonly cipher = new RecordingCipher();
  readonly authorityKeyId = new FilesKeyBundlePolicy().authorityKeyId({ principalId: PRINCIPAL, publicKey: PUBLIC_KEY });
  readonly envelope = { version: 1, purpose: 'authority-custody', context: CONTEXT } as unknown as FilesKeyBundleEnvelope;
  readonly database: RecordingDatabase;
  readonly authority: VaultFilesKeyBundleAuthority;

  constructor(withCurrentEnvelope: boolean) {
    const row = {
      principal_id: PRINCIPAL, collection_id: COLLECTION, key_version: '3', key_epoch: '2',
      authority_key_id: this.authorityKeyId, authority_bundle: this.envelope,
    };
    this.database = new RecordingDatabase(sql => withCurrentEnvelope && /^SELECT .*authority_bundle/.test(sql) ? [row] : []);
    this.authority = new VaultFilesKeyBundleAuthority(this.database as unknown as Database, this.lease, undefined, this.cipher);
  }

  recover(context: FilesKeyBundleContext = CONTEXT): Promise<FilesKeyBundleEnvelope> {
    return this.authority.authorizeDeviceRecovery({ context, devicePublicKey: 'device-public-key' });
  }

  /** Every statement that touches a Files key bundle table. */
  custodyStatements(): Statement[] {
    return this.database.log.filter(entry => /files_key_bundle_(current|envelopes)/.test(entry.sql));
  }
}

describe('Files key custody: read path (device recovery) is locked and principal-scoped', () => {
  it('reads the current envelope inside the collection-lock transaction with FOR UPDATE scoped to the principal', async() => { // risk: key custody race (stale generation re-wrapped during rotation)
    const fx = new CustodyFixture(true);
    await expect(fx.recover()).resolves.toMatchObject({ purpose: 'device-recovery', context: CONTEXT });

    expect(fx.database.log.filter(entry => entry.via === 'pool')).toEqual([]);
    const statements = fx.database.statements();
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(fx.database.log[1].values).toEqual([`sulla:files:key-bundle:${ PRINCIPAL }:${ COLLECTION }`]);
    expect(statements.slice(-2)).toEqual(['COMMIT', 'release']);

    const reads = fx.custodyStatements();
    expect(reads).toHaveLength(1);
    expect(reads[0].sql).toMatch(/\bFOR UPDATE\b/);
    expect(reads[0].sql).toMatch(/\bprincipal_id=\$1\b/);
    expect(reads[0].sql).toMatch(/\bcollection_id=\$2\b/);
    expect(reads[0].values).toEqual([PRINCIPAL, COLLECTION, 3, 2]);
    expect(fx.cipher.rewrapKeys).toHaveLength(1);
  });

  it('never re-wraps with the private key when the Vault locks while the custody read is awaiting', async() => { // risk: key material used after lock (TOCTOU)
    const fx = new CustodyFixture(true);
    let release!: () => void;
    fx.database.holdNextRead(new Promise<void>(resolve => { release = resolve }), () => fx.lease.lock());
    const pending = fx.recover();
    await new Promise<void>(resolve => setImmediate(resolve));
    release();

    await expect(pending).rejects.toMatchObject({ code: 'vault_locked' });
    expect(fx.cipher.rewrapKeys).toEqual([]);
    expect(fx.database.statements()).not.toContain('COMMIT');
    expect(fx.database.statements().slice(-2)).toEqual(['ROLLBACK', 'release']);
  });

  it('refuses another principal before issuing any SQL or touching the key', async() => { // risk: cross-principal key disclosure
    const fx = new CustodyFixture(true);
    await expect(fx.recover({ ...CONTEXT, principalId: 'someone-else' })).rejects.toMatchObject({ code: 'principal_denied', status: 403 });
    expect(fx.database.log).toEqual([]);
    expect(fx.cipher.rewrapKeys).toEqual([]);
  });

  it('denies recovery when no current envelope exists and rolls the transaction back', async() => { // risk: recovery of a superseded generation
    const fx = new CustodyFixture(false);
    await expect(fx.recover()).rejects.toMatchObject({ code: 'context_denied', status: 403 });
    expect(fx.cipher.rewrapKeys).toEqual([]);
    expect(fx.database.statements().slice(-2)).toEqual(['ROLLBACK', 'release']);
  });
});

describe('Files key custody: rotate path (register bundle) is locked and principal-scoped', () => {
  it('reads the current generation FOR UPDATE inside the lock and writes only the principal\'s rows', async() => { // risk: concurrent rotation loses or forks custody
    const fx = new CustodyFixture(false);
    await expect(fx.authority.registerBundle({ context: CONTEXT, authorityKeyId: fx.authorityKeyId, envelope: fx.envelope })).resolves.toBeUndefined();

    expect(fx.database.log.filter(entry => entry.via === 'pool')).toEqual([]);
    const statements = fx.database.statements();
    expect(statements.slice(0, 2)).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))']);
    expect(statements.slice(-2)).toEqual(['COMMIT', 'release']);

    const custody = fx.custodyStatements();
    const currentRead = custody.find(entry => /^SELECT .* FROM files_key_bundle_current/.test(entry.sql));
    expect(currentRead?.sql).toMatch(/\bprincipal_id=\$1\b.*\bFOR UPDATE\b/);
    expect(currentRead?.values).toEqual([PRINCIPAL, COLLECTION]);
    for (const entry of custody) expect(entry.values?.[0]).toBe(PRINCIPAL);
    expect(custody.filter(entry => /^SELECT/.test(entry.sql)).every(entry => /\bprincipal_id=\$1\b/.test(entry.sql))).toBe(true);
  });

  it('zeroes the opened collection keys, including when the Vault locks right after opening', async() => { // risk: plaintext collection keys left in memory
    const fx = new CustodyFixture(false);
    await fx.authority.registerBundle({ context: CONTEXT, authorityKeyId: fx.authorityKeyId, envelope: fx.envelope });
    const locked = new CustodyFixture(false);
    const open = locked.cipher.open.bind(locked.cipher);
    locked.cipher.open = async() => { const material = await open(); locked.lease.lock(); return material };
    await expect(locked.authority.registerBundle({ context: CONTEXT, authorityKeyId: locked.authorityKeyId, envelope: locked.envelope }))
      .rejects.toMatchObject({ code: 'vault_locked' });

    for (const material of [...fx.cipher.opened, ...locked.cipher.opened]) {
      expect(material.dataKey.every(byte => byte === 0)).toBe(true);
      expect(material.dedupKey.every(byte => byte === 0)).toBe(true);
    }
    expect(locked.database.log).toEqual([]);
  });
});
