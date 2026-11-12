// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DeviceMessage, type DevicePurpose } from '@sulla/domain';

import { DeviceId } from './DeviceId';
import type {
  DeviceClock, DeviceIdentityHealth, DeviceIdStore, DeviceKeyStore, Ed25519Primitives, KeyOrigin, KeyRotateProof,
  LegacyDeviceIdSource, LoadedDeviceIdentity, RandomSource,
} from './DeviceIdentityPorts';

export interface DeviceIdentityServiceDependencies {
  ids:       DeviceIdStore;
  keys:      DeviceKeyStore;
  legacyIds: LegacyDeviceIdSource | null;
  crypto:    Ed25519Primitives;
  random:    RandomSource;
  clock:     DeviceClock;
  logger:    { warn(message: string): void };
}

interface LoadedKey { publicKey: string; seed: Uint8Array; origin: KeyOrigin }

/**
 * Loads or creates this install's device id and Ed25519 key, and signs purpose-bound
 * device messages with it (Desktop-local twin of the planned domain DeviceIdentityService).
 */
export class DeviceIdentityService {
  private id: DeviceId | null = null;
  private idMintedHere = false;
  private health: DeviceIdentityHealth = { idPersisted: true };
  private key: LoadedKey | null = null;

  constructor(private readonly deps: DeviceIdentityServiceDependencies) {}

  async loadOrCreateId(): Promise<string> {
    if (this.id) return this.id.value;

    const fromFile = this.readStoredId();
    if (fromFile) return this.remember(fromFile).value;

    const legacyRaw = await this.readLegacyId();
    const legacy = DeviceId.tryParse(legacyRaw);
    if (legacy) {
      // Migration out of app settings. If the file can't be written the settings copy still holds it.
      this.persistToFile(legacy, true);

      return this.remember(legacy).value;
    }

    const fresh = DeviceId.generate(this.deps.random);
    const savedToFile = this.persistToFile(fresh, false);
    const savedToLegacy = await this.writeLegacyId(fresh);
    if (!savedToFile && !savedToLegacy) {
      // Never mint quietly on every launch: the id lives for this process only and is flagged.
      this.health = { idPersisted: false, error: 'device_id_not_saved' };
      this.deps.logger.warn('[deviceIdentity] the new device id could not be saved; this computer will not register with Sulla Cloud until it can be.');
    }
    this.idMintedHere = true;

    return this.remember(fresh).value;
  }

  /** The saved id, without creating one or touching app settings (sync, safe before the database). */
  readExistingId(): string | null {
    return this.id?.value ?? this.readStoredId()?.value ?? null;
  }

  async loadOrCreate(): Promise<LoadedDeviceIdentity> {
    const deviceId = await this.loadOrCreateId();
    const key = this.loadOrCreateKey();

    return { deviceId, publicKey: key.publicKey, keyOrigin: key.origin };
  }

  publicKey(): string { return this.loadOrCreateKey().publicKey }

  keyOrigin(): KeyOrigin | null { return this.key?.origin ?? null }

  identityHealth(): DeviceIdentityHealth { return { ...this.health } }

  /** Sign exactly `tag + parts` (base64 signature). */
  signExact(purpose: DevicePurpose, parts: (string | number)[]): string {
    const message = new DeviceMessage(purpose, parts).toBytes();

    return Buffer.from(this.deps.crypto.ed25519Sign(this.loadOrCreateKey().seed, message)).toString('base64');
  }

  /** Sign `tag + parts + ts` (unix seconds). */
  sign(purpose: DevicePurpose, parts: (string | number)[]): KeyRotateProof {
    const ts = this.deps.clock.nowSeconds();

    return { ts, signature: this.signExact(purpose, [...parts, ts]) };
  }

  /**
   * Proof for `/devices/register`, the exact bytes Cloud's DeviceKeyVerifier checks:
   * `sulla-key-rotate-v1\n<userId>\n<deviceId>\n<publicKey>\n<ts>`, signed by this machine's current key.
   */
  async keyRotateProof(userId: string): Promise<KeyRotateProof> {
    const { deviceId, publicKey } = await this.loadOrCreate();

    return this.sign('key-rotate', [userId, deviceId, publicKey]);
  }

  resetCache(): void {
    this.id = null;
    this.idMintedHere = false;
    this.health = { idPersisted: true };
    this.key = null;
  }

  private loadOrCreateKey(): LoadedKey {
    if (this.key) return this.key;

    const stored = this.deps.keys.read();
    if (stored) {
      // Recompute rather than trust the stored public key.
      this.key = { publicKey: this.encode(this.deps.crypto.ed25519PublicKey(stored.seed)), seed: stored.seed, origin: 'existing' };

      return this.key;
    }

    const hadIdBefore = !this.idMintedHere && this.readStoredId() !== null;
    const seed = this.deps.random.bytes(32);
    if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('The secure random source returned the wrong number of bytes.');
    const publicKey = this.encode(this.deps.crypto.ed25519PublicKey(seed));
    this.deps.keys.write({ publicKey, seed, createdAt: this.deps.clock.nowIso() });
    const origin: KeyOrigin = hadIdBefore ? 'regenerated_after_loss' : 'created';
    if (origin === 'regenerated_after_loss') {
      this.deps.logger.warn('[deviceKey] this computer had a device id but no device key; made a new key. Sulla Cloud will ask to re-link this computer.');
    }
    this.key = { publicKey, seed, origin };

    return this.key;
  }

  private readStoredId(): DeviceId | null {
    const raw = this.deps.ids.read();
    if (raw === null) return null;
    const id = DeviceId.tryParse(raw);
    if (!id) this.deps.logger.warn('[deviceIdentity] ignoring a malformed saved device id.');

    return id;
  }

  private remember(id: DeviceId): DeviceId {
    this.id = id;

    return id;
  }

  private persistToFile(id: DeviceId, migrating: boolean): boolean {
    try {
      this.deps.ids.write(id.value);

      return true;
    } catch (error) {
      this.deps.logger.warn(`[deviceIdentity] could not save the device id${ migrating ? ' while migrating it from settings' : '' }: ${ error instanceof Error ? error.message : String(error) }`);

      return false;
    }
  }

  private async readLegacyId(): Promise<string | null> {
    if (!this.deps.legacyIds) return null;
    try { return await this.deps.legacyIds.read() } catch { return null }
  }

  private async writeLegacyId(id: DeviceId): Promise<boolean> {
    if (!this.deps.legacyIds) return false;
    try {
      await this.deps.legacyIds.write(id.value);

      return true;
    } catch {
      return false;
    }
  }

  private encode(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64') }
}
