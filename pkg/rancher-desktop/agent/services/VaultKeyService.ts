// VaultKeyService - Manages the vault encryption key (VMK) for encrypting
// all integration credentials at rest.
//
// Key hierarchy:
//   Master Password → PBKDF2 → VMK (256-bit)
//   VMK protected at rest by Electron safeStorage (OS keychain)
//   Recovery key → PBKDF2 → decrypt backup of VMK
//
// The VMK is NEVER logged, serialized to disk in plain text, or exposed via IPC.
// It lives only in memory within this service.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import paths from '@pkg/utils/paths';

const VAULT_PREFIX = '$VAULT$';
// Existing vaults use 100k iterations. New vaults use the stronger setting;
// the metadata file keeps password recovery backward-compatible.
const LEGACY_PBKDF2_ITERATIONS = 100_000;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = 'sha512';
const VMK_LENGTH = 32; // 256-bit
const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const RECOVERY_KEY_BYTES = 16; // 128-bit
const MIN_MASTER_PASSWORD_LENGTH = 12;

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

let vaultKeyServiceInstance: VaultKeyService | null = null;

export function getVaultKeyService(): VaultKeyService {
  if (!vaultKeyServiceInstance) {
    vaultKeyServiceInstance = new VaultKeyService();
  }
  return vaultKeyServiceInstance;
}

export class VaultKeyService {
  private vmk:      Buffer | null = null;
  private sullaDir: string;
  private safeStorageOverride: SafeStorageLike | null | undefined;

  constructor(sullaDir: string = paths.sullaConfig, safeStorage?: SafeStorageLike | null) {
    this.sullaDir = sullaDir;
    this.safeStorageOverride = safeStorage;
  }

  // ─── File paths ──────────────────────────────────────────────────

  private get saltPath(): string {
    return path.join(this.sullaDir, 'vault-salt');
  }

  private get keyEncPath(): string {
    return path.join(this.sullaDir, 'vault-key.enc');
  }

  private get backupPath(): string {
    return path.join(this.sullaDir, 'vault-key.backup');
  }

  private get recoveryHashPath(): string {
    return path.join(this.sullaDir, 'vault-recovery-hash');
  }

  private get verifyPath(): string {
    return path.join(this.sullaDir, 'vault-verify');
  }

  private get kdfConfigPath(): string {
    return path.join(this.sullaDir, 'vault-kdf.json');
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from safeStorage on app startup.
   * Returns true if VMK was loaded into memory, false if recovery/setup needed.
   */
  async initialize(): Promise<boolean> {
    this.ensureSullaDir();

    if (this.vmk) {
      // Still ensure canary exists even if already unlocked
      if (!fs.existsSync(this.verifyPath)) {
        this.writeVerifyCanary();
      }
      console.log('[VaultKeyService] Already unlocked');
      return true;
    }

    if (!fs.existsSync(this.keyEncPath)) {
      console.log('[VaultKeyService] No vault key file found — first-time setup needed');
      return false;
    }

    // Auto-unlock vault from safeStorage so the agent can work immediately.
    // The UI login screen is a separate gate — it doesn't depend on vault state.
    try {
      const safeStorage = this.getSafeStorage();
      if (!safeStorage?.isEncryptionAvailable()) {
        console.log('[VaultKeyService] safeStorage unavailable — master password required');
        return false;
      }

      const encryptedBlob = fs.readFileSync(this.keyEncPath);
      const decrypted = safeStorage.decryptString(encryptedBlob);
      this.vmk = Buffer.from(decrypted, 'base64');

      if (this.vmk.length !== VMK_LENGTH) {
        console.error('[VaultKeyService] Decrypted VMK has unexpected length');
        this.vmk = null;
        return false;
      }

      // Ensure the key is authentic before exposing an unlocked vault. Legacy
      // vaults without a canary get one only after the keychain blob passes
      // its structural checks.
      if (fs.existsSync(this.verifyPath)) {
        if (!this.verifyCanary(this.vmk)) {
          this.vmk.fill(0);
          this.vmk = null;
          console.error('[VaultKeyService] Keychain VMK failed vault verification');
          return false;
        }
      } else {
        this.writeVerifyCanary();
      }

      console.log('[VaultKeyService] Vault auto-unlocked from safeStorage');
      return true;
    } catch (err) {
      console.error('[VaultKeyService] Failed to load VMK from safeStorage:', err);
      this.vmk = null;
      return false;
    }
  }

  /**
   * First-time setup: derive VMK from master password, store via safeStorage,
   * generate recovery key, create encrypted backup.
   */
  async setupFromMasterPassword(masterPassword: string): Promise<{ recoveryKey: string }> {
    this.assertMasterPassword(masterPassword);
    this.ensureSullaDir();

    // Generate and store salt and KDF metadata atomically.
    const salt = crypto.randomBytes(SALT_LENGTH);
    this.writePrivateFile(this.saltPath, salt);
    this.writePrivateFile(this.kdfConfigPath, JSON.stringify({
      algorithm:  'pbkdf2',
      digest:     PBKDF2_DIGEST,
      iterations: PBKDF2_ITERATIONS,
      version:    1,
    }), 'utf8');

    // Derive VMK from master password
    this.vmk = crypto.pbkdf2Sync(masterPassword, salt, PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);

    // Store VMK via safeStorage
    this.storeVmkViaSafeStorage();

    // Generate recovery key
    const recoveryKey = this.generateRecoveryKey();

    // Store recovery key verification hash (using crypto, not bcrypt, to avoid native dep)
    const recoveryHash = crypto
      .createHash('sha256')
      .update(recoveryKey)
      .digest('hex');
    this.writePrivateFile(this.recoveryHashPath, recoveryHash, 'utf8');

    // Create encrypted backup of VMK using recovery key
    this.createRecoveryBackup(recoveryKey);

    // Store an encrypted canary so we can verify the password on future logins
    this.writeVerifyCanary();

    console.log('[VaultKeyService] Vault setup complete');
    return { recoveryKey };
  }

  /**
   * Change the master password, re-keying the vault.
   * Returns a decrypt function bound to the OLD VMK so callers can
   * re-encrypt existing data with the new key.
   */
  async changePassword(newPassword: string): Promise<{
    recoveryKey: string;
    oldDecrypt:  (encrypted: string) => string;
    rollback:  () => void;
  }> {
    if (!this.vmk) {
      throw new Error('[VaultKeyService] Vault must be unlocked to change password');
    }

    // Snapshot the old key material so a failed database re-key can restore
    // the exact previous vault state without leaving credentials unreadable.
    const oldVmk = Buffer.from(this.vmk);
    const snapshot = this.snapshotPasswordState();
    const oldDecrypt = (encrypted: string): string => {
      if (!encrypted.startsWith(VAULT_PREFIX)) return encrypted;
      const packed = Buffer.from(encrypted.slice(VAULT_PREFIX.length), 'base64');
      if (packed.length < GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH) throw new Error('[VaultKeyService] Invalid encrypted value');
      const iv = packed.subarray(0, GCM_IV_LENGTH);
      const authTag = packed.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
      const ciphertext = packed.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
      const decipher = crypto.createDecipheriv('aes-256-gcm', oldVmk, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    };

    // Now set up the new key (replaces salt, VMK, safeStorage, recovery)
    const result = await this.setupFromMasterPassword(newPassword);

    return {
      recoveryKey: result.recoveryKey,
      oldDecrypt,
      rollback:  () => this.restorePasswordState(snapshot, oldVmk),
    };
  }

  // ─── Encrypt / Decrypt ───────────────────────────────────────────

  /**
   * Encrypt plaintext string. Returns $VAULT$ prefixed string.
   * Throws if vault is locked.
   */
  encrypt(plaintext: string): string {
    if (!this.vmk) {
      throw new Error('[VaultKeyService] Vault is locked — cannot encrypt');
    }

    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.vmk, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: iv (12) + authTag (16) + ciphertext
    const packed = Buffer.concat([iv, authTag, encrypted]);
    return VAULT_PREFIX + packed.toString('base64');
  }

  /**
   * Decrypt a $VAULT$ prefixed string. Returns plaintext.
   * Throws if vault is locked or decryption fails.
   */
  decrypt(encrypted: string): string {
    if (!this.vmk) {
      throw new Error('[VaultKeyService] Vault is locked — cannot decrypt');
    }

    if (!this.isEncrypted(encrypted)) {
      throw new Error('[VaultKeyService] Value is not vault-encrypted');
    }

    const packed = Buffer.from(encrypted.slice(VAULT_PREFIX.length), 'base64');
    if (packed.length < GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH) {
      throw new Error('[VaultKeyService] Invalid encrypted value');
    }

    const iv = packed.subarray(0, GCM_IV_LENGTH);
    const authTag = packed.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.vmk, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /** Check if a string is vault-encrypted */
  isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith(VAULT_PREFIX);
  }

  // ─── Recovery ────────────────────────────────────────────────────

  /**
   * Recover VMK using the recovery key.
   * Decrypts the backup file, re-initializes safeStorage.
   */
  async recoverFromRecoveryKey(recoveryKey: string): Promise<boolean> {
    try {
      // Verify recovery key hash
      if (!fs.existsSync(this.recoveryHashPath)) {
        console.error('[VaultKeyService] Recovery key hash is missing');
        return false;
      }
      const storedHash = fs.readFileSync(this.recoveryHashPath, 'utf-8').trim();
      const providedHash = crypto.createHash('sha256').update(recoveryKey).digest('hex');
      const storedHashBytes = Buffer.from(storedHash, 'hex');
      const providedHashBytes = Buffer.from(providedHash, 'hex');
      if (storedHashBytes.length !== providedHashBytes.length ||
        !crypto.timingSafeEqual(storedHashBytes, providedHashBytes)) {
        console.error('[VaultKeyService] Recovery key verification failed');
        return false;
      }

      // Decrypt backup
      if (!fs.existsSync(this.backupPath)) {
        console.error('[VaultKeyService] No backup file found');
        return false;
      }

      const backupData = fs.readFileSync(this.backupPath);
      const backupSalt = backupData.subarray(0, SALT_LENGTH);
      const backupIv = backupData.subarray(SALT_LENGTH, SALT_LENGTH + GCM_IV_LENGTH);
      const backupAuthTag = backupData.subarray(
        SALT_LENGTH + GCM_IV_LENGTH,
        SALT_LENGTH + GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH,
      );
      const backupCiphertext = backupData.subarray(SALT_LENGTH + GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);

      // Derive decryption key from recovery key
      const backupKey = crypto.pbkdf2Sync(recoveryKey, backupSalt, PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);

      const decipher = crypto.createDecipheriv('aes-256-gcm', backupKey, backupIv);
      decipher.setAuthTag(backupAuthTag);

      this.vmk = Buffer.concat([
        decipher.update(backupCiphertext),
        decipher.final(),
      ]);
      if (this.vmk.length !== VMK_LENGTH) {
        this.vmk.fill(0);
        this.vmk = null;
        return false;
      }

      // Re-store in safeStorage
      this.storeVmkViaSafeStorage();

      // Ensure canary exists for future password verification
      this.writeVerifyCanary();

      console.log('[VaultKeyService] VMK recovered from recovery key');
      return true;
    } catch (err) {
      console.error('[VaultKeyService] Recovery from recovery key failed:', err);
      this.vmk = null;
      return false;
    }
  }

  /**
   * Recover VMK by re-deriving from master password + stored salt.
   * Use when safeStorage is unavailable but user knows their password.
   */
  async recoverFromMasterPassword(masterPassword: string): Promise<boolean> {
    try {
      if (!fs.existsSync(this.saltPath)) {
        console.error('[VaultKeyService] No salt file found — cannot recover from password');
        return false;
      }

      const salt = fs.readFileSync(this.saltPath);
      const candidateVmk = crypto.pbkdf2Sync(
        masterPassword,
        salt,
        this.readKdfIterations(),
        VMK_LENGTH,
        PBKDF2_DIGEST,
      );

      // Verify the derived key is correct before accepting it
      if (!this.verifyCanary(candidateVmk)) {
        console.error('[VaultKeyService] Password verification failed — wrong master password');
        return false;
      }

      this.vmk = candidateVmk;

      // Re-store in safeStorage for next startup
      this.storeVmkViaSafeStorage();

      console.log('[VaultKeyService] VMK recovered from master password');
      return true;
    } catch (err) {
      console.error('[VaultKeyService] Recovery from master password failed:', err);
      this.vmk = null;
      return false;
    }
  }

  /** Check if the canary file exists so passwords can be verified */
  canVerifyPassword(): boolean {
    return fs.existsSync(this.verifyPath);
  }

  /** Check if the vault is unlocked (VMK in memory) */
  isUnlocked(): boolean {
    return this.vmk !== null;
  }

  /** Check if vault has been set up (key files exist) */
  isSetUp(): boolean {
    return fs.existsSync(this.saltPath) && (
      fs.existsSync(this.keyEncPath) || fs.existsSync(this.backupPath)
    );
  }

  /**
   * Lock the vault — zero out VMK from memory.
   * Typically called on app quit.
   */
  lock(): void {
    if (this.vmk) {
      this.vmk.fill(0);
      this.vmk = null;
    }
    console.log('[VaultKeyService] Vault locked by user — requires password to unlock');
  }

  // ─── Internals ───────────────────────────────────────────────────

  /**
   * Write an encrypted canary value that can be used to verify the VMK later.
   * AES-256-GCM will fail to decrypt with the wrong key (auth tag mismatch),
   * so we can detect an incorrect master password.
   */
  private writeVerifyCanary(): void {
    if (!this.vmk) return;
    try {
      const canary = this.encrypt('sulla-vault-canary');
      this.writePrivateFile(this.verifyPath, canary, 'utf8');
    } catch (err) {
      console.warn('[VaultKeyService] Failed to write verify canary:', err);
    }
  }

  /**
   * Verify a candidate VMK by attempting to decrypt the canary file.
   * Returns true if no canary exists (legacy vaults before this check).
   */
  private verifyCanary(candidateVmk: Buffer): boolean {
    if (!fs.existsSync(this.verifyPath)) {
      // Never accept an unverified password: doing so would replace a valid
      // key with one derived from a typo and make encrypted data unrecoverable.
      return false;
    }
    try {
      const encrypted = fs.readFileSync(this.verifyPath, 'utf-8');
      if (!encrypted.startsWith(VAULT_PREFIX)) return false;

      const packed = Buffer.from(encrypted.slice(VAULT_PREFIX.length), 'base64');
      if (packed.length < GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH) return false;
      const iv = packed.subarray(0, GCM_IV_LENGTH);
      const authTag = packed.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
      const ciphertext = packed.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);

      const decipher = crypto.createDecipheriv('aes-256-gcm', candidateVmk, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      return decrypted.toString('utf8') === 'sulla-vault-canary';
    } catch {
      // GCM auth tag mismatch = wrong key
      return false;
    }
  }

  /** Generate a 128-bit recovery key formatted as 8 groups of 4 hex chars. */
  generateRecoveryKey(): string {
    const bytes = crypto.randomBytes(RECOVERY_KEY_BYTES);
    const hex = bytes.toString('hex').toUpperCase();
    return hex.match(/.{1,4}/g)!.join('-');
  }

  private snapshotPasswordState(): Map<string, Buffer | null> {
    const snapshot = new Map<string, Buffer | null>();
    for (const filePath of [
      this.saltPath,
      this.kdfConfigPath,
      this.keyEncPath,
      this.backupPath,
      this.recoveryHashPath,
      this.verifyPath,
    ]) {
      snapshot.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
    }
    return snapshot;
  }

  private restorePasswordState(snapshot: Map<string, Buffer | null>, oldVmk: Buffer): void {
    for (const [filePath, data] of snapshot) {
      if (data === null) {
        try { fs.unlinkSync(filePath) } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else {
        this.writePrivateFile(filePath, data);
      }
    }
    if (this.vmk) this.vmk.fill(0);
    this.vmk = Buffer.from(oldVmk);
    oldVmk.fill(0);
  }

  /** Store VMK in safeStorage, writing encrypted blob to disk */
  private storeVmkViaSafeStorage(): void {
    if (!this.vmk) return;

    try {
      const safeStorage = this.getSafeStorage();
      if (safeStorage?.isEncryptionAvailable()) {
        const vmkBase64 = this.vmk.toString('base64');
        const encrypted = safeStorage.encryptString(vmkBase64);
        this.writePrivateFile(this.keyEncPath, encrypted);
        console.log('[VaultKeyService] VMK stored via safeStorage');
      } else {
        console.warn('[VaultKeyService] safeStorage unavailable — VMK not persisted to keychain');
      }
    } catch (err) {
      console.warn('[VaultKeyService] Failed to store VMK via safeStorage:', err);
    }
  }

  /** Create encrypted backup of VMK using recovery key */
  private createRecoveryBackup(recoveryKey: string): void {
    if (!this.vmk) return;

    const backupSalt = crypto.randomBytes(SALT_LENGTH);
    const backupKey = crypto.pbkdf2Sync(recoveryKey, backupSalt, PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);
    const backupIv = crypto.randomBytes(GCM_IV_LENGTH);

    const cipher = crypto.createCipheriv('aes-256-gcm', backupKey, backupIv);
    const encrypted = Buffer.concat([
      cipher.update(this.vmk),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: salt (32) + iv (12) + authTag (16) + ciphertext
    const packed = Buffer.concat([backupSalt, backupIv, authTag, encrypted]);
    this.writePrivateFile(this.backupPath, packed);
    console.log('[VaultKeyService] Recovery backup created');
  }

  /** Get Electron safeStorage module, or null if unavailable */
  private getSafeStorage(): typeof import('electron').safeStorage | null {
    if (this.safeStorageOverride !== undefined) return this.safeStorageOverride as typeof import('electron').safeStorage;
    try {
      const { safeStorage } = require('electron');
      return safeStorage;
    } catch {
      return null;
    }
  }

  /** Ensure ~/.sulla directory exists */
  private ensureSullaDir(): void {
    if (!fs.existsSync(this.sullaDir)) {
      fs.mkdirSync(this.sullaDir, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(this.sullaDir, 0o700) } catch { /* best effort on unsupported filesystems */ }
  }

  private assertMasterPassword(masterPassword: string): void {
    if (typeof masterPassword !== 'string' || masterPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
      throw new Error('[VaultKeyService] Master password must be at least ' + MIN_MASTER_PASSWORD_LENGTH + ' characters');
    }
  }

  private readKdfIterations(): number {
    try {
      const config = JSON.parse(fs.readFileSync(this.kdfConfigPath, 'utf8')) as { iterations?: unknown };
      if (typeof config.iterations === 'number' &&
        Number.isInteger(config.iterations) &&
        config.iterations >= LEGACY_PBKDF2_ITERATIONS &&
        config.iterations <= 2_000_000) {
        return config.iterations;
      }
    } catch { /* legacy vault or damaged metadata: use the legacy default */ }
    return LEGACY_PBKDF2_ITERATIONS;
  }

  /** Write sensitive material with restrictive permissions and an atomic rename. */
  private writePrivateFile(filePath: string, data: string | Buffer, encoding?: BufferEncoding): void {
    const temporaryPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
    try {
      fs.writeFileSync(temporaryPath, data, { encoding, mode: 0o600 });
      try { fs.chmodSync(temporaryPath, 0o600) } catch { /* best effort */ }
      const fd = fs.openSync(temporaryPath, 'r');
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temporaryPath, filePath);
      try { fs.chmodSync(filePath, 0o600) } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temporaryPath) } catch { /* best effort cleanup */ }
      throw error;
    }
  }
}
