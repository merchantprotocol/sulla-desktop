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
import * as os from 'os';

const VAULT_PREFIX = '$VAULT$';
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';
const VMK_LENGTH = 32; // 256-bit
const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const RECOVERY_KEY_BYTES = 16; // 128-bit

let vaultKeyServiceInstance: VaultKeyService | null = null;

export function getVaultKeyService(): VaultKeyService {
  if (!vaultKeyServiceInstance) {
    vaultKeyServiceInstance = new VaultKeyService();
  }
  return vaultKeyServiceInstance;
}

export class VaultKeyService {
  private vmk: Buffer | null = null;
  private sullaDir: string;

  constructor() {
    this.sullaDir = path.join(os.homedir(), '.sulla');
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

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from safeStorage on app startup.
   * Returns true if VMK was loaded into memory, false if recovery/setup needed.
   */
  async initialize(): Promise<boolean> {
    this.ensureSullaDir();

    if (this.vmk) {
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
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
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
    this.ensureSullaDir();

    // Generate and store salt
    const salt = crypto.randomBytes(SALT_LENGTH);
    fs.writeFileSync(this.saltPath, salt);

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
    fs.writeFileSync(this.recoveryHashPath, recoveryHash, 'utf-8');

    // Create encrypted backup of VMK using recovery key
    this.createRecoveryBackup(recoveryKey);

    console.log('[VaultKeyService] Vault setup complete');
    return { recoveryKey };
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
      if (fs.existsSync(this.recoveryHashPath)) {
        const storedHash = fs.readFileSync(this.recoveryHashPath, 'utf-8').trim();
        const providedHash = crypto
          .createHash('sha256')
          .update(recoveryKey)
          .digest('hex');
        if (storedHash !== providedHash) {
          console.error('[VaultKeyService] Recovery key verification failed');
          return false;
        }
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


      // Re-store in safeStorage
      this.storeVmkViaSafeStorage();

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
      this.vmk = crypto.pbkdf2Sync(masterPassword, salt, PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);

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

  /** Generate a 128-bit recovery key formatted as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
  generateRecoveryKey(): string {
    const bytes = crypto.randomBytes(RECOVERY_KEY_BYTES);
    const hex = bytes.toString('hex').toUpperCase();
    // Split into 6 groups of 4-5 chars
    const groups: string[] = [];
    for (let i = 0; i < hex.length; i += 5) {
      groups.push(hex.slice(i, i + 5));
    }
    // Pad to exactly 6 groups
    while (groups.length < 6) {
      groups.push(crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 5));
    }
    return groups.slice(0, 6).join('-');
  }

  /** Store VMK in safeStorage, writing encrypted blob to disk */
  private storeVmkViaSafeStorage(): void {
    if (!this.vmk) return;

    try {
      const safeStorage = this.getSafeStorage();
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        const vmkBase64 = this.vmk.toString('base64');
        const encrypted = safeStorage.encryptString(vmkBase64);
        fs.writeFileSync(this.keyEncPath, encrypted);
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
    fs.writeFileSync(this.backupPath, packed);
    console.log('[VaultKeyService] Recovery backup created');
  }

  /** Get Electron safeStorage module, or null if unavailable */
  private getSafeStorage(): typeof import('electron').safeStorage | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { safeStorage } = require('electron');
      return safeStorage;
    } catch {
      return null;
    }
  }

  /** Ensure ~/.sulla directory exists */
  private ensureSullaDir(): void {
    if (!fs.existsSync(this.sullaDir)) {
      fs.mkdirSync(this.sullaDir, { recursive: true });
    }
  }
}
