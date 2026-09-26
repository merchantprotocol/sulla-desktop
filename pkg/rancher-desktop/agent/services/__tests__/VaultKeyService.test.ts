import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { VaultKeyService } from '../VaultKeyService';

class FakeSafeStorage {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): Buffer {
    return Buffer.from('fake-safe-storage:' + value, 'utf8');
  }

  decryptString(value: Buffer): string {
    const decoded = value.toString('utf8');
    if (!decoded.startsWith('fake-safe-storage:')) throw new Error('invalid fake keychain blob');
    return decoded.slice('fake-safe-storage:'.length);
  }
}

describe('VaultKeyService production invariants', () => {
  let vaultDir: string;
  let safeStorage: FakeSafeStorage;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-vault-'));
    safeStorage = new FakeSafeStorage();
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  test('round-trips high-volume secrets, detects tampering, and persists private files securely', async() => {
    const service = new VaultKeyService(vaultDir, safeStorage);
    const { recoveryKey } = await service.setupFromMasterPassword('correct horse battery staple');

    expect(recoveryKey).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
    expect(fs.statSync(vaultDir).mode & 0o777).toBe(0o700);

    for (const file of ['vault-salt', 'vault-kdf.json', 'vault-key.enc', 'vault-key.backup', 'vault-recovery-hash', 'vault-verify']) {
      expect(fs.statSync(path.join(vaultDir, file)).mode & 0o777).toBe(0o600);
    }

    const values = Array.from({ length: 500 }, (_, i) => (
      i % 2 === 0
        ? 'secret-' + i + '-' + crypto.randomBytes(64).toString('hex')
        : 'unicode-🔐-' + 'x'.repeat(i % 97)
    ));
    const encrypted = values.map(value => service.encrypt(value));
    expect(new Set(encrypted).size).toBe(values.length);
    expect(encrypted.every(value => value.startsWith('$VAULT$'))).toBe(true);
    expect(encrypted.map(value => service.decrypt(value))).toEqual(values);

    const tampered = encrypted[0].slice(0, -1) + (encrypted[0].endsWith('A') ? 'B' : 'A');
    expect(() => service.decrypt(tampered)).toThrow();

    service.lock();
    expect(service.isUnlocked()).toBe(false);
    expect(await service.recoverFromMasterPassword('wrong password')).toBe(false);
    expect(service.isUnlocked()).toBe(false);
    expect(await service.recoverFromMasterPassword('correct horse battery staple')).toBe(true);
    expect(service.decrypt(encrypted[17])).toBe(values[17]);

    service.lock();
    expect(await service.recoverFromRecoveryKey(recoveryKey)).toBe(true);
    expect(service.decrypt(encrypted[499])).toBe(values[499]);
    expect(fs.readdirSync(vaultDir).filter(file => file.includes('.tmp-'))).toEqual([]);
  });

  test('fails closed when password verification material is missing', async() => {
    const service = new VaultKeyService(vaultDir, safeStorage);
    await service.setupFromMasterPassword('correct horse battery staple');
    fs.unlinkSync(path.join(vaultDir, 'vault-verify'));
    service.lock();

    expect(await service.recoverFromMasterPassword('correct horse battery staple')).toBe(false);
    expect(service.isUnlocked()).toBe(false);
  });

  test('can roll back a staged password change without losing the old key', async() => {
    const service = new VaultKeyService(vaultDir, safeStorage);
    await service.setupFromMasterPassword('correct horse battery staple');
    const oldCiphertext = service.encrypt('must-survive-rekey-failure');

    const staged = await service.changePassword('new correct horse battery');
    expect(staged.oldDecrypt(oldCiphertext)).toBe('must-survive-rekey-failure');
    staged.rollback();

    service.lock();
    expect(await service.recoverFromMasterPassword('correct horse battery staple')).toBe(true);
    expect(service.decrypt(oldCiphertext)).toBe('must-survive-rekey-failure');
  });

  test('supports a fresh instance auto-unlock through the OS keychain wrapper', async() => {
    const service = new VaultKeyService(vaultDir, safeStorage);
    await service.setupFromMasterPassword('correct horse battery staple');
    const freshService = new VaultKeyService(vaultDir, safeStorage);

    expect(await freshService.initialize()).toBe(true);
    expect(freshService.isUnlocked()).toBe(true);
  });

  test('rejects weak setup passwords before creating a vault', async() => {
    const service = new VaultKeyService(vaultDir, safeStorage);
    await expect(service.setupFromMasterPassword('too-short')).rejects.toThrow('at least 12');
    expect(fs.readdirSync(vaultDir)).toEqual([]);
  });
});
