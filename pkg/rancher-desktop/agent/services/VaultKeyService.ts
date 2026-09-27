// VaultKeyService - Manages the vault encryption key (VMK) for encrypting
// all integration credentials at rest.
//
// Key hierarchy:
//   VMK (256-bit)                     — encrypts every $VAULT$ value
//   Master password → PBKDF2 → KEK    — wraps the VMK (vault-key.wrapped)
//   Recovery key → PBKDF2 → key       — wraps the VMK (vault-key.backup)
//   Electron safeStorage (OS keychain) — caches the VMK (vault-key.enc)
//
// Legacy vaults (before vault-key.wrapped existed) derived the VMK directly
// from the master password + vault-salt. They keep working unchanged; the
// first password change converts them to the wrapped layout without
// re-encrypting any stored credential, because the VMK itself never changes.
//
// Durability rules:
//   * Every key file is written atomically (tmp + fsync + rename) with 0600.
//   * Setup refuses to run over an existing vault — that would orphan every
//     stored credential.
//   * A password change only rewrites the wrapped VMK, so the recovery key,
//     safeStorage cache, existing backups and all DB ciphertext stay valid.
//
// The VMK is NEVER logged, serialized to disk in plain text, or exposed via IPC.
// It lives only in memory within this service.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import paths from '@pkg/utils/paths';

const VAULT_PREFIX = '$VAULT$';
const LEGACY_PBKDF2_ITERATIONS = 100_000;
const WRAP_PBKDF2_ITERATIONS = 210_000; // OWASP 2023 minimum for PBKDF2-HMAC-SHA512
const PBKDF2_DIGEST = 'sha512';
const VMK_LENGTH = 32; // 256-bit
const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const RECOVERY_KEY_BYTES = 16; // 128-bit
const CANARY_PLAINTEXT = 'sulla-vault-canary';

// Unlock throttling: free attempts, then an exponential delay capped at MAX.
const FREE_UNLOCK_ATTEMPTS = 5;
const MAX_UNLOCK_DELAY_MS = 30_000;

let vaultKeyServiceInstance: VaultKeyService | null = null;

export function getVaultKeyService(): VaultKeyService {
  if (!vaultKeyServiceInstance) {
    vaultKeyServiceInstance = new VaultKeyService();
  }
  return vaultKeyServiceInstance;
}

/** Wrapped-VMK file format (vault-key.wrapped). */
interface WrappedVmkFile {
  v:     1;
  kdf:   'pbkdf2-sha512';
  iter:  number;
  salt:  string;
  iv:    string;
  tag:   string;
  ct:    string;
}

/**
 * Everything needed to re-derive a vault's VMK away from the machine that
 * created it. Contains no plaintext and no unwrapped key.
 */
export interface VaultKeyMaterial {
  salt?:           string; // base64, legacy vaults only
  wrapped?:        string; // vault-key.wrapped JSON
  recoveryBackup?: string; // base64 of vault-key.backup
  canary?:         string; // $VAULT$ canary
}

/** Returns one stored $VAULT$ value, or null when the vault holds none. */
export type CiphertextSampleProvider = () => Promise<string | null>;

export type VaultDecryptor = (encrypted: string) => string;

/** The slice of Electron safeStorage the vault uses (injectable for tests). */
export type SafeStorageLike = Pick<typeof import('electron').safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;

// ─── Pure crypto helpers ─────────────────────────────────────────────

function gcmSeal(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function gcmOpen(key: Buffer, packed: Buffer): Buffer {
  if (packed.length < GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH) {
    throw new Error('[VaultKeyService] Ciphertext is truncated');
  }
  const iv = packed.subarray(0, GCM_IV_LENGTH);
  const tag = packed.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
  const ct = packed.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function vaultEncrypt(key: Buffer, plaintext: string): string {
  return VAULT_PREFIX + gcmSeal(key, Buffer.from(plaintext, 'utf8')).toString('base64');
}

function vaultDecrypt(key: Buffer, encrypted: string): string {
  if (typeof encrypted !== 'string' || !encrypted.startsWith(VAULT_PREFIX)) {
    throw new Error('[VaultKeyService] Value is not vault-encrypted');
  }

  return gcmOpen(key, Buffer.from(encrypted.slice(VAULT_PREFIX.length), 'base64')).toString('utf8');
}

function canaryMatches(key: Buffer, canary: string | undefined): boolean | null {
  if (!canary?.startsWith(VAULT_PREFIX)) return null; // cannot tell
  try {
    return vaultDecrypt(key, canary) === CANARY_PLAINTEXT;
  } catch {
    return false;
  }
}

function wrapVmk(vmk: Buffer, password: string, iterations = WRAP_PBKDF2_ITERATIONS): WrappedVmkFile {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const kek = crypto.pbkdf2Sync(password, salt, iterations, VMK_LENGTH, PBKDF2_DIGEST);
  const packed = gcmSeal(kek, vmk);

  kek.fill(0);

  return {
    v:    1,
    kdf:  'pbkdf2-sha512',
    iter: iterations,
    salt: salt.toString('base64'),
    iv:   packed.subarray(0, GCM_IV_LENGTH).toString('base64'),
    tag:  packed.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH).toString('base64'),
    ct:   packed.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH).toString('base64'),
  };
}

/** Returns the VMK, or null when the password is wrong. Throws on a malformed file. */
function unwrapVmk(raw: string, password: string): Buffer | null {
  const file = JSON.parse(raw) as WrappedVmkFile;

  if (file?.v !== 1 || file.kdf !== 'pbkdf2-sha512' || !Number.isInteger(file.iter) || file.iter < 10_000) {
    throw new Error('[VaultKeyService] Unsupported wrapped key file');
  }
  const kek = crypto.pbkdf2Sync(password, Buffer.from(file.salt, 'base64'), file.iter, VMK_LENGTH, PBKDF2_DIGEST);

  try {
    const vmk = gcmOpen(kek, Buffer.concat([
      Buffer.from(file.iv, 'base64'),
      Buffer.from(file.tag, 'base64'),
      Buffer.from(file.ct, 'base64'),
    ]));

    return vmk.length === VMK_LENGTH ? vmk : null;
  } catch {
    return null;
  } finally {
    kek.fill(0);
  }
}

/** Returns the VMK, or null when the recovery key is wrong or the backup is malformed. */
function unwrapRecoveryBackup(backup: Buffer, recoveryKey: string): Buffer | null {
  if (backup.length < SALT_LENGTH + GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH + VMK_LENGTH) return null;
  const salt = backup.subarray(0, SALT_LENGTH);
  const key = crypto.pbkdf2Sync(recoveryKey, salt, LEGACY_PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);

  try {
    const vmk = gcmOpen(key, backup.subarray(SALT_LENGTH));

    return vmk.length === VMK_LENGTH ? vmk : null;
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/**
 * Normalize user-typed recovery keys: tolerate lowercase, spaces, missing
 * dashes. Canonical form is 6 dash-separated groups of 5 hex characters.
 */
export function normalizeRecoveryKey(input: string): string {
  const compact = String(input ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');

  if (compact.length !== 30) return String(input ?? '').trim().toUpperCase();

  return compact.match(/.{5}/g)!.join('-');
}

/**
 * Write a file atomically with owner-only permissions. A crash leaves either
 * the old complete file or the new complete file — never a torn one.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${ path.basename(filePath) }.tmp-${ process.pid }-${ crypto.randomBytes(4).toString('hex') }`);
  const fd = fs.openSync(tmp, 'w', mode);

  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err;
  }
  try {
    const dirFd = fs.openSync(dir, 'r');

    try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
  } catch { /* directory fsync is best-effort (unsupported on some platforms) */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class VaultKeyService {
  private vmk:      Buffer | null = null;
  private sullaDir: string;
  private ciphertextSampleProvider: CiphertextSampleProvider | null = null;
  private failedUnlocks = 0;
  private unlockQueue: Promise<unknown> = Promise.resolve();

  constructor(sullaDir?: string, private readonly safeStorageOverride?: SafeStorageLike) {
    this.sullaDir = sullaDir ?? paths.sullaConfig;
  }

  // ─── File paths ──────────────────────────────────────────────────

  private get saltPath(): string {
    return path.join(this.sullaDir, 'vault-salt');
  }

  private get keyEncPath(): string {
    return path.join(this.sullaDir, 'vault-key.enc');
  }

  private get wrappedPath(): string {
    return path.join(this.sullaDir, 'vault-key.wrapped');
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

  private get keyFilePaths(): string[] {
    return [this.saltPath, this.keyEncPath, this.wrappedPath, this.backupPath, this.recoveryHashPath, this.verifyPath];
  }

  /**
   * Register a source of stored ciphertext. Used to verify a candidate key
   * when the canary file is missing or damaged, so a wrong password can never
   * be accepted and cached as the vault key.
   */
  setCiphertextSampleProvider(provider: CiphertextSampleProvider | null): void {
    this.ciphertextSampleProvider = provider;
  }

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from safeStorage on app startup.
   * Returns true if VMK was loaded into memory, false if recovery/setup needed.
   */
  async initialize(): Promise<boolean> {
    this.ensureSullaDir();
    this.tightenKeyFilePermissions();

    if (this.vmk) {
      this.ensureCanary();
      console.log('[VaultKeyService] Already unlocked');
      return true;
    }

    if (!fs.existsSync(this.keyEncPath)) {
      console.log('[VaultKeyService] No safeStorage key cache — master password required');
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

      const decrypted = Buffer.from(safeStorage.decryptString(fs.readFileSync(this.keyEncPath)), 'base64');

      if (decrypted.length !== VMK_LENGTH) {
        console.error('[VaultKeyService] Decrypted VMK has unexpected length');
        return false;
      }
      if (canaryMatches(decrypted, this.readCanary()) === false) {
        // The keychain cache disagrees with the vault. Never adopt it: writes
        // under the wrong key would be unreadable with the real one.
        console.error('[VaultKeyService] safeStorage key does not match the vault canary — master password required');
        decrypted.fill(0);
        return false;
      }

      this.vmk = decrypted;
      this.ensureCanary();

      console.log('[VaultKeyService] Vault auto-unlocked from safeStorage');
      return true;
    } catch (err) {
      console.error('[VaultKeyService] Failed to load VMK from safeStorage:', err);
      this.vmk = null;
      return false;
    }
  }

  /**
   * First-time setup: generate a random VMK, wrap it with the master password,
   * store via safeStorage, generate recovery key, create encrypted backup.
   *
   * Refuses to run when a vault already exists — overwriting the key would make
   * every stored credential permanently unreadable.
   */
  async setupFromMasterPassword(masterPassword: string): Promise<{ recoveryKey: string }> {
    if (typeof masterPassword !== 'string' || masterPassword.length === 0) {
      throw new Error('[VaultKeyService] Master password is required');
    }
    if (this.isSetUp()) {
      throw new Error('VAULT_ALREADY_SET_UP: a vault already exists; unlock it or restore from backup instead');
    }
    this.ensureSullaDir();

    const vmk = crypto.randomBytes(VMK_LENGTH);
    const recoveryKey = this.generateRecoveryKey();

    // Write every auxiliary file first; vault-key.wrapped is the commit point
    // that makes isSetUp() true. A crash before it leaves setup re-runnable.
    writeFileAtomic(this.backupPath, this.buildRecoveryBackup(vmk, recoveryKey));
    writeFileAtomic(this.recoveryHashPath, this.hashRecoveryKey(recoveryKey));
    writeFileAtomic(this.verifyPath, vaultEncrypt(vmk, CANARY_PLAINTEXT));
    writeFileAtomic(this.wrappedPath, JSON.stringify(wrapVmk(vmk, masterPassword)));

    this.vmk = vmk;
    this.storeVmkViaSafeStorage();

    console.log('[VaultKeyService] Vault setup complete');
    return { recoveryKey };
  }

  /**
   * Change the master password. Only the password wrapping of the VMK is
   * rewritten (one atomic file write), so stored credentials, the recovery key,
   * and existing backups all remain valid. Nothing needs re-encryption.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (!this.vmk) {
      throw new Error('[VaultKeyService] Vault must be unlocked to change password');
    }
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      throw new Error('[VaultKeyService] New password is required');
    }

    const candidate = await this.serializeUnlock(() => this.deriveVmkFromPassword(currentPassword));

    if (!candidate || !crypto.timingSafeEqual(candidate, this.vmk)) {
      candidate?.fill(0);
      this.recordUnlockFailure();
      throw new Error('VAULT_WRONG_PASSWORD: current master password is incorrect');
    }
    candidate.fill(0);

    writeFileAtomic(this.wrappedPath, JSON.stringify(wrapVmk(this.vmk, newPassword)));
    this.ensureCanary();

    // The legacy salt would let the OLD password keep deriving the VMK.
    if (fs.existsSync(this.saltPath)) {
      fs.unlinkSync(this.saltPath);
    }

    console.log('[VaultKeyService] Master password changed');
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

    return vaultEncrypt(this.vmk, plaintext);
  }

  /**
   * Decrypt a $VAULT$ prefixed string. Returns plaintext.
   * Throws if vault is locked or decryption fails.
   */
  decrypt(encrypted: string): string {
    if (!this.vmk) {
      throw new Error('[VaultKeyService] Vault is locked — cannot decrypt');
    }

    return vaultDecrypt(this.vmk, encrypted);
  }

  /** Check if a string is vault-encrypted */
  isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith(VAULT_PREFIX);
  }

  // ─── Unlock / Recovery ───────────────────────────────────────────

  /**
   * Recover VMK using the recovery key.
   * Decrypts the backup file, re-initializes safeStorage.
   */
  async recoverFromRecoveryKey(recoveryKey: string): Promise<boolean> {
    return this.serializeUnlock(async() => {
      try {
        const normalized = normalizeRecoveryKey(recoveryKey);

        if (fs.existsSync(this.recoveryHashPath)) {
          const stored = Buffer.from(fs.readFileSync(this.recoveryHashPath, 'utf-8').trim(), 'utf8');
          const provided = Buffer.from(this.hashRecoveryKey(normalized), 'utf8');

          if (stored.length !== provided.length || !crypto.timingSafeEqual(stored, provided)) {
            console.error('[VaultKeyService] Recovery key verification failed');
            return this.recordUnlockFailure();
          }
        }

        if (!fs.existsSync(this.backupPath)) {
          console.error('[VaultKeyService] No backup file found');
          return this.recordUnlockFailure();
        }

        const vmk = unwrapRecoveryBackup(fs.readFileSync(this.backupPath), normalized);

        if (!vmk || !(await this.verifyCandidate(vmk))) {
          vmk?.fill(0);
          console.error('[VaultKeyService] Recovery backup could not be opened with this key');
          return this.recordUnlockFailure();
        }

        this.adoptVmk(vmk);
        console.log('[VaultKeyService] VMK recovered from recovery key');
        return true;
      } catch (err) {
        console.error('[VaultKeyService] Recovery from recovery key failed:', err);
        return this.recordUnlockFailure();
      }
    });
  }

  /**
   * Unlock with the master password (wrapped layout, or legacy salt derivation).
   * Use when safeStorage is unavailable, and for UI login verification.
   */
  async recoverFromMasterPassword(masterPassword: string): Promise<boolean> {
    return this.serializeUnlock(async() => {
      try {
        const vmk = this.deriveVmkFromPassword(masterPassword);

        if (!vmk || !(await this.verifyCandidate(vmk))) {
          vmk?.fill(0);
          console.error('[VaultKeyService] Password verification failed — wrong master password');
          return this.recordUnlockFailure();
        }

        this.adoptVmk(vmk);
        console.log('[VaultKeyService] VMK recovered from master password');
        return true;
      } catch (err) {
        console.error('[VaultKeyService] Recovery from master password failed:', err);
        return this.recordUnlockFailure();
      }
    });
  }

  /** Check if the canary file exists so passwords can be verified */
  canVerifyPassword(): boolean {
    return fs.existsSync(this.verifyPath) || fs.existsSync(this.wrappedPath);
  }

  /** Check if the vault is unlocked (VMK in memory) */
  isUnlocked(): boolean {
    return this.vmk !== null;
  }

  /** Check if vault has been set up (key files exist) */
  isSetUp(): boolean {
    if (fs.existsSync(this.wrappedPath)) return true;

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
    console.log('[VaultKeyService] Vault locked — requires password to unlock');
  }

  // ─── Portable key material (backups) ─────────────────────────────

  /** Snapshot of the on-disk key material needed to reopen this vault elsewhere. */
  exportKeyMaterial(): VaultKeyMaterial {
    const material: VaultKeyMaterial = {};

    if (fs.existsSync(this.saltPath)) material.salt = fs.readFileSync(this.saltPath).toString('base64');
    if (fs.existsSync(this.wrappedPath)) material.wrapped = fs.readFileSync(this.wrappedPath, 'utf-8');
    if (fs.existsSync(this.backupPath)) material.recoveryBackup = fs.readFileSync(this.backupPath).toString('base64');
    const canary = this.readCanary();

    if (canary) material.canary = canary;

    return material;
  }

  /** True when the in-memory VMK is the key described by this material. */
  matchesKeyMaterial(material: VaultKeyMaterial): boolean {
    return !!this.vmk && canaryMatches(this.vmk, material.canary) === true;
  }

  /**
   * Build a decryptor for ciphertext produced under some other key material,
   * e.g. a backup from another machine or before a key reset. Returns null
   * when the secret does not open the material.
   */
  openKeyMaterial(material: VaultKeyMaterial, secret: { password?: string; recoveryKey?: string }): VaultDecryptor | null {
    const candidates: Buffer[] = [];

    try {
      if (secret.password) {
        if (material.wrapped) {
          const vmk = unwrapVmk(material.wrapped, secret.password);

          if (vmk) candidates.push(vmk);
        }
        if (material.salt) {
          candidates.push(crypto.pbkdf2Sync(secret.password, Buffer.from(material.salt, 'base64'), LEGACY_PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST));
        }
      }
      if (secret.recoveryKey && material.recoveryBackup) {
        const vmk = unwrapRecoveryBackup(Buffer.from(material.recoveryBackup, 'base64'), normalizeRecoveryKey(secret.recoveryKey));

        if (vmk) candidates.push(vmk);
      }
    } catch (err) {
      console.warn('[VaultKeyService] Key material could not be parsed:', (err as Error).message);
    }

    // Without a canary we can only trust a key that came out of an
    // authenticated wrapper (GCM already proved it).
    const hasCanary = !!material.canary;
    const key = candidates.find(k => (hasCanary ? canaryMatches(k, material.canary) === true : candidates.length === 1));

    if (!key) return null;
    const pinned = Buffer.from(key);

    candidates.forEach(k => k.fill(0));

    return (encrypted: string) => vaultDecrypt(pinned, encrypted);
  }

  // ─── Internals ───────────────────────────────────────────────────

  /** Derive the VMK for a password without touching service state. */
  private deriveVmkFromPassword(password: string): Buffer | null {
    if (typeof password !== 'string' || password.length === 0) return null;

    if (fs.existsSync(this.wrappedPath)) {
      return unwrapVmk(fs.readFileSync(this.wrappedPath, 'utf-8'), password);
    }
    if (fs.existsSync(this.saltPath)) {
      return crypto.pbkdf2Sync(password, fs.readFileSync(this.saltPath), LEGACY_PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);
    }
    console.error('[VaultKeyService] No wrapped key or salt file found — cannot unlock with password');
    return null;
  }

  /**
   * Prove a candidate VMK belongs to this vault. The canary is authoritative;
   * when it is missing or unreadable, fall back to real stored ciphertext.
   * Only an empty vault (nothing to protect yet) accepts an unverifiable key.
   */
  private async verifyCandidate(candidate: Buffer): Promise<boolean> {
    const byCanary = canaryMatches(candidate, this.readCanary());

    if (byCanary !== null) return byCanary;

    if (this.ciphertextSampleProvider) {
      const sample = await this.ciphertextSampleProvider();

      if (sample) {
        try {
          vaultDecrypt(candidate, sample);
          return true;
        } catch {
          return false;
        }
      }
      return true; // provably empty vault
    }

    console.warn('[VaultKeyService] No canary and no ciphertext sample — accepting unverifiable key');
    return true;
  }

  private adoptVmk(vmk: Buffer): void {
    if (this.vmk && this.vmk !== vmk) this.vmk.fill(0);
    this.vmk = vmk;
    this.failedUnlocks = 0;
    this.storeVmkViaSafeStorage();
    this.ensureCanary();
  }

  /** Run unlock attempts one at a time so throttling can't be raced. */
  private serializeUnlock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.unlockQueue.then(async() => {
      const delay = this.currentUnlockDelay();

      if (delay > 0) await sleep(delay);

      return fn();
    });

    this.unlockQueue = run.catch(() => undefined);

    return run;
  }

  private currentUnlockDelay(): number {
    const over = this.failedUnlocks - FREE_UNLOCK_ATTEMPTS;

    return over < 0 ? 0 : Math.min(MAX_UNLOCK_DELAY_MS, 1000 * 2 ** over);
  }

  private recordUnlockFailure(): false {
    this.failedUnlocks++;

    return false;
  }

  private readCanary(): string | undefined {
    try {
      return fs.existsSync(this.verifyPath) ? fs.readFileSync(this.verifyPath, 'utf-8').trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /** Write the canary only if it is missing or unreadable under the current VMK. */
  private ensureCanary(): void {
    if (!this.vmk) return;
    if (canaryMatches(this.vmk, this.readCanary()) === true) return;
    try {
      writeFileAtomic(this.verifyPath, vaultEncrypt(this.vmk, CANARY_PLAINTEXT));
    } catch (err) {
      console.warn('[VaultKeyService] Failed to write verify canary:', err);
    }
  }

  private hashRecoveryKey(recoveryKey: string): string {
    // Not bcrypt: the key carries 120 bits of entropy, so a fast hash is fine.
    return crypto.createHash('sha256').update(recoveryKey).digest('hex');
  }

  /**
   * Generate a recovery key formatted as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
   * (30 hex characters = 120 bits).
   */
  generateRecoveryKey(): string {
    const hex = crypto.randomBytes(RECOVERY_KEY_BYTES).toString('hex').toUpperCase().slice(0, 30);

    return hex.match(/.{5}/g)!.join('-');
  }

  /** Store VMK in safeStorage, writing encrypted blob to disk */
  private storeVmkViaSafeStorage(): void {
    if (!this.vmk) return;

    try {
      const safeStorage = this.getSafeStorage();
      if (safeStorage?.isEncryptionAvailable()) {
        writeFileAtomic(this.keyEncPath, safeStorage.encryptString(this.vmk.toString('base64')));
        console.log('[VaultKeyService] VMK stored via safeStorage');
      } else {
        console.warn('[VaultKeyService] safeStorage unavailable — VMK not persisted to keychain');
      }
    } catch (err) {
      console.warn('[VaultKeyService] Failed to store VMK via safeStorage:', err);
    }
  }

  /** Pack: salt (32) + iv (12) + authTag (16) + ciphertext */
  private buildRecoveryBackup(vmk: Buffer, recoveryKey: string): Buffer {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(recoveryKey, salt, LEGACY_PBKDF2_ITERATIONS, VMK_LENGTH, PBKDF2_DIGEST);

    try {
      return Buffer.concat([salt, gcmSeal(key, vmk)]);
    } finally {
      key.fill(0);
    }
  }

  /** Existing installs wrote key files world-readable; restrict them. */
  private tightenKeyFilePermissions(): void {
    if (process.platform === 'win32') return;
    for (const file of this.keyFilePaths) {
      try {
        if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077) !== 0) {
          fs.chmodSync(file, 0o600);
        }
      } catch (err) {
        console.warn(`[VaultKeyService] Could not restrict permissions on ${ path.basename(file) }:`, err);
      }
    }
  }

  /** Get Electron safeStorage module, or null if unavailable */
  private getSafeStorage(): SafeStorageLike | null {
    if (this.safeStorageOverride) return this.safeStorageOverride;
    try {
      const { safeStorage } = require('electron');
      return safeStorage ?? null;
    } catch {
      return null;
    }
  }

  /** Ensure ~/.sulla directory exists */
  private ensureSullaDir(): void {
    if (!fs.existsSync(this.sullaDir)) {
      fs.mkdirSync(this.sullaDir, { recursive: true, mode: 0o700 });
    }
  }
}
