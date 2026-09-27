/**
 * Stress + adversarial tests for the vault key hierarchy. Everything runs
 * against a real temp directory and real crypto; only Electron's safeStorage
 * (the OS keychain) is faked.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const keychain = { available: true };
const keychainStub = {
  isEncryptionAvailable: () => keychain.available,
  encryptString:         (s: string) => Buffer.from(`KC:${ s }`),
  decryptString:         (b: Buffer) => {
    const s = b.toString();

    if (!s.startsWith('KC:')) throw new Error('keychain decrypt failed');

    return s.slice(3);
  },
};
const renameFault = { target: '' };

jest.unstable_mockModule('fs', () => {
  const faulty = {
    ...fs,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (renameFault.target && String(to).endsWith(renameFault.target)) throw new Error('simulated power loss');

      return fs.renameSync(from, to);
    },
  };

  return { ...faulty, default: faulty };
});
jest.unstable_mockModule('@pkg/utils/paths', () => ({ __esModule: true, default: { sullaConfig: '/nonexistent' } }));

const { VaultKeyService: RealVaultKeyService, normalizeRecoveryKey, writeFileAtomic } = await import('../VaultKeyService');

/** Every instance gets the fake OS keychain. */
class VaultKeyService extends RealVaultKeyService {
  constructor(dir: string) {
    super(dir, keychainStub);
  }
}

// Real PBKDF2 and bulk crypto: allow for a loaded CI machine.
jest.setTimeout(60_000);

const PW = 'correct horse battery staple';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
}

async function freshVault(dir = tmpDir()) {
  const svc = new VaultKeyService(dir);
  const { recoveryKey } = await svc.setupFromMasterPassword(PW);

  return { dir, svc, recoveryKey };
}

/** Build a vault exactly as the pre-hardening code wrote it (VMK = PBKDF2(pw, salt)). */
function writeLegacyVault(dir: string, password: string, recoveryKey: string): Buffer {
  const salt = crypto.randomBytes(32);
  const vmk = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha512');
  const seal = (key: Buffer, pt: Buffer) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(pt), c.final()]);

    return Buffer.concat([iv, c.getAuthTag(), ct]);
  };
  const bSalt = crypto.randomBytes(32);
  const bKey = crypto.pbkdf2Sync(recoveryKey, bSalt, 100_000, 32, 'sha512');

  fs.writeFileSync(path.join(dir, 'vault-salt'), salt, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'vault-key.enc'), Buffer.from(`KC:${ vmk.toString('base64') }`), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'vault-key.backup'), Buffer.concat([bSalt, seal(bKey, vmk)]), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'vault-recovery-hash'), crypto.createHash('sha256').update(recoveryKey).digest('hex'), { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'vault-verify'), `$VAULT$${ seal(vmk, Buffer.from('sulla-vault-canary')).toString('base64') }`, { mode: 0o644 });

  return vmk;
}

beforeEach(() => {
  keychain.available = true;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('setup and persistence', () => {
  it('round-trips and survives an app restart via the keychain', async() => {
    const { dir, svc } = await freshVault();
    const ct = svc.encrypt('hunter2');

    const restarted = new VaultKeyService(dir);

    expect(await restarted.initialize()).toBe(true);
    expect(restarted.decrypt(ct)).toBe('hunter2');
  });

  it('writes every key file owner-only', async() => {
    const { dir } = await freshVault();

    for (const f of fs.readdirSync(dir)) {
      expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to set up over an existing vault (would orphan every credential)', async() => {
    const { dir, svc } = await freshVault();
    const ct = svc.encrypt('keep me');

    await expect(new VaultKeyService(dir).setupFromMasterPassword('other')).rejects.toThrow('VAULT_ALREADY_SET_UP');
    const again = new VaultKeyService(dir);

    expect(await again.initialize()).toBe(true);
    expect(again.decrypt(ct)).toBe('keep me');
  });

  it('a crash before the commit file leaves setup re-runnable, not half-set-up', async() => {
    const dir = tmpDir();

    renameFault.target = 'vault-key.wrapped';
    await expect(new VaultKeyService(dir).setupFromMasterPassword(PW)).rejects.toThrow('simulated power loss');
    renameFault.target = '';
    expect(new VaultKeyService(dir).isSetUp()).toBe(false);
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([]);
    await expect(new VaultKeyService(dir).setupFromMasterPassword(PW)).resolves.toHaveProperty('recoveryKey');
  });

  it('atomic writes leave no temp files behind', () => {
    const dir = tmpDir();

    for (let i = 0; i < 200; i++) writeFileAtomic(path.join(dir, 'f'), `v${ i }`);
    expect(fs.readdirSync(dir)).toEqual(['f']);
    expect(fs.readFileSync(path.join(dir, 'f'), 'utf8')).toBe('v199');
  });
});

describe('unlock paths', () => {
  it('password unlock works without the keychain; wrong passwords never unlock', async() => {
    const { dir, svc } = await freshVault();
    const ct = svc.encrypt('s3cret');

    keychain.available = false;
    const cold = new VaultKeyService(dir);

    expect(await cold.initialize()).toBe(false);
    for (const bad of ['', 'Correct horse battery staple', `${ PW } `, 'x'.repeat(10_000)]) {
      expect(await cold.recoverFromMasterPassword(bad)).toBe(false);
      expect(cold.isUnlocked()).toBe(false);
    }
    // Reset throttle so the test stays fast.
    (cold as any).failedUnlocks = 0;
    expect(await cold.recoverFromMasterPassword(PW)).toBe(true);
    expect(cold.decrypt(ct)).toBe('s3cret');
  });

  it('recovery key unlocks and tolerates how humans type it', async() => {
    const { dir, svc, recoveryKey } = await freshVault();
    const ct = svc.encrypt('v');
    const variants = [
      recoveryKey,
      recoveryKey.toLowerCase(),
      recoveryKey.replace(/-/g, ''),
      ` ${ recoveryKey.replace(/-/g, ' ') } `,
    ];

    for (const v of variants) {
      keychain.available = false;
      const cold = new VaultKeyService(dir);

      expect(await cold.recoverFromRecoveryKey(v)).toBe(true);
      expect(cold.decrypt(ct)).toBe('v');
    }
    expect(normalizeRecoveryKey(recoveryKey.toLowerCase())).toBe(recoveryKey);
  });

  it('never adopts a keychain key that disagrees with the vault canary', async() => {
    const { dir } = await freshVault();

    fs.writeFileSync(path.join(dir, 'vault-key.enc'), Buffer.from(`KC:${ crypto.randomBytes(32).toString('base64') }`));
    const svc = new VaultKeyService(dir);

    expect(await svc.initialize()).toBe(false);
    expect(await svc.recoverFromMasterPassword(PW)).toBe(true); // and password repairs the cache
    expect(await new VaultKeyService(dir).initialize()).toBe(true);
  });

  it('with the canary lost, verifies against real ciphertext instead of accepting any password', async() => {
    const dir = tmpDir();
    const vmk = writeLegacyVault(dir, PW, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF');
    const sample = (() => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', vmk, iv);
      const ct = Buffer.concat([c.update('db value'), c.final()]);

      return `$VAULT$${ Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }`;
    })();

    fs.unlinkSync(path.join(dir, 'vault-verify'));
    keychain.available = false;
    const svc = new VaultKeyService(dir);

    svc.setCiphertextSampleProvider(async() => sample);
    expect(await svc.recoverFromMasterPassword('wrong')).toBe(false);
    // The keychain cache must not have been overwritten by the wrong key.
    expect(fs.readFileSync(path.join(dir, 'vault-key.enc')).toString()).toBe(`KC:${ vmk.toString('base64') }`);
    expect(await svc.recoverFromMasterPassword(PW)).toBe(true);
    expect(svc.decrypt(sample)).toBe('db value');
  });

  it('serializes and throttles brute-force attempts', async() => {
    const { dir } = await freshVault();
    const svc = new VaultKeyService(dir);

    (svc as any).failedUnlocks = 4;
    expect((svc as any).currentUnlockDelay()).toBe(0);
    await svc.recoverFromMasterPassword('nope');
    await svc.recoverFromMasterPassword('nope');
    expect((svc as any).currentUnlockDelay()).toBeGreaterThanOrEqual(2000);
    (svc as any).failedUnlocks = 100;
    expect((svc as any).currentUnlockDelay()).toBe(30_000);
    (svc as any).failedUnlocks = 0;
    expect(await svc.recoverFromMasterPassword(PW)).toBe(true);
    expect((svc as any).failedUnlocks).toBe(0);
  });
});

describe('password change (the old flow silently orphaned data and the recovery key)', () => {
  it('rejects a wrong current password and changes nothing', async() => {
    const { dir, svc } = await freshVault();
    const before = fs.readFileSync(path.join(dir, 'vault-key.wrapped'), 'utf8');

    await expect(svc.changePassword('wrong', 'new-password')).rejects.toThrow('VAULT_WRONG_PASSWORD');
    expect(fs.readFileSync(path.join(dir, 'vault-key.wrapped'), 'utf8')).toBe(before);
  });

  it('keeps all ciphertext, the recovery key, and the keychain valid; old password stops working', async() => {
    const { dir, svc, recoveryKey } = await freshVault();
    const cts = Array.from({ length: 50 }, (_, i) => svc.encrypt(`secret-${ i }`));

    await svc.changePassword(PW, 'brand new pw');

    keychain.available = false;
    const cold = new VaultKeyService(dir);

    expect(await cold.recoverFromMasterPassword(PW)).toBe(false);
    expect(await cold.recoverFromMasterPassword('brand new pw')).toBe(true);
    cts.forEach((ct, i) => expect(cold.decrypt(ct)).toBe(`secret-${ i }`));

    const viaRecovery = new VaultKeyService(dir);

    expect(await viaRecovery.recoverFromRecoveryKey(recoveryKey)).toBe(true);
    expect(viaRecovery.decrypt(cts[0])).toBe('secret-0');

    keychain.available = true;
    const viaKeychain = new VaultKeyService(dir);

    expect(await viaKeychain.initialize()).toBe(true);
    expect(viaKeychain.decrypt(cts[49])).toBe('secret-49');
  });

  it('upgrades a legacy vault in place: no re-encryption, salt removed, old password revoked', async() => {
    const dir = tmpDir();
    const recoveryKey = 'A1B2C-D3E4F-01234-56789-ABCDE-F0123';

    writeLegacyVault(dir, PW, recoveryKey);
    const svc = new VaultKeyService(dir);

    expect(await svc.initialize()).toBe(true);
    // Legacy files were world-readable; initialize must tighten them.
    expect(fs.statSync(path.join(dir, 'vault-salt')).mode & 0o077).toBe(0);
    const ct = svc.encrypt('legacy secret');

    await svc.changePassword(PW, 'upgraded pw');
    expect(fs.existsSync(path.join(dir, 'vault-salt'))).toBe(false);
    expect(new VaultKeyService(dir).isSetUp()).toBe(true);

    keychain.available = false;
    const cold = new VaultKeyService(dir);

    expect(await cold.recoverFromMasterPassword(PW)).toBe(false);
    expect(await cold.recoverFromMasterPassword('upgraded pw')).toBe(true);
    expect(cold.decrypt(ct)).toBe('legacy secret');
    expect(await new VaultKeyService(dir).recoverFromRecoveryKey(recoveryKey)).toBe(true);
  });

  it('10 consecutive password changes keep every credential readable', async() => {
    const { dir, svc } = await freshVault();
    const ct = svc.encrypt('durable');
    let pw = PW;

    for (let i = 0; i < 10; i++) {
      const next = `pw-${ i }-${ crypto.randomBytes(4).toString('hex') }`;

      await svc.changePassword(pw, next);
      pw = next;
    }
    keychain.available = false;
    const cold = new VaultKeyService(dir);

    expect(await cold.recoverFromMasterPassword(pw)).toBe(true);
    expect(cold.decrypt(ct)).toBe('durable');
  });
});

describe('cipher stress', () => {
  it('round-trips thousands of adversarial values', async() => {
    const { svc } = await freshVault();
    const values = [
      '', ' ', '\0', '$VAULT$', '$VAULT$not-really', 'emoji 🔐🗝️👨‍👩‍👧‍👦', 'x'.repeat(1_000_000),
      '\uD800', // lone surrogate: must at least not throw or corrupt neighbours
      ...Array.from({ length: 3000 }, () => crypto.randomBytes(Math.floor(Math.random() * 300)).toString('latin1')),
    ];

    for (const v of values) {
      const ct = svc.encrypt(v);

      expect(svc.isEncrypted(ct)).toBe(true);
      expect(svc.decrypt(ct)).toBe(Buffer.from(v, 'utf8').toString('utf8'));
    }
  });

  it('uses a fresh IV every time', async() => {
    const { svc } = await freshVault();
    const seen = new Set(Array.from({ length: 5000 }, () => svc.encrypt('same').slice(7, 23)));

    expect(seen.size).toBe(5000);
  });

  it('detects tampering of any byte and truncation', async() => {
    const { svc } = await freshVault();
    const ct = svc.encrypt('integrity matters');
    const raw = Buffer.from(ct.slice(7), 'base64');

    for (let i = 0; i < raw.length; i++) {
      const bad = Buffer.from(raw);

      bad[i] ^= 0x01;
      expect(() => svc.decrypt(`$VAULT$${ bad.toString('base64') }`)).toThrow();
    }
    expect(() => svc.decrypt('$VAULT$AAAA')).toThrow();
    expect(() => svc.decrypt('$VAULT$')).toThrow();
  });

  it('a locked vault refuses to encrypt or decrypt', async() => {
    const { svc } = await freshVault();
    const ct = svc.encrypt('x');

    svc.lock();
    expect(() => svc.encrypt('y')).toThrow(/locked/);
    expect(() => svc.decrypt(ct)).toThrow(/locked/);
  });
});

describe('portable key material', () => {
  it('opens another vault\'s material only with its password or recovery key', async() => {
    const a = await freshVault();
    const b = await freshVault();
    const ct = a.svc.encrypt('from machine A');
    const material = a.svc.exportKeyMaterial();

    expect(b.svc.matchesKeyMaterial(material)).toBe(false);
    expect(a.svc.matchesKeyMaterial(material)).toBe(true);
    expect(b.svc.openKeyMaterial(material, { password: 'wrong' })).toBeNull();
    expect(b.svc.openKeyMaterial(material, { recoveryKey: b.recoveryKey })).toBeNull();
    expect(b.svc.openKeyMaterial(material, { password: PW })!(ct)).toBe('from machine A');
    expect(b.svc.openKeyMaterial(material, { recoveryKey: a.recoveryKey.toLowerCase() })!(ct)).toBe('from machine A');
    expect(JSON.stringify(material)).not.toContain('from machine A');
  });
});
