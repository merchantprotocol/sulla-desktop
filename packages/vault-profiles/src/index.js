// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';

const DATABASE_PREFIX = 'sulla_vault_';
const DATABASE_SUFFIX = /^[a-z0-9_]+$/;
const SECRET_FIELD = /(?:token|secret|password|key|credential|kdf|private|cipher|wrap)/i;

/** Opaque stable identifier for one Cloud-account profile. */
export class ProfileId {
  constructor(value) {
    if (typeof value !== 'string' || !/^profile_[a-f0-9]{64}$/.test(value)) {
      throw new TypeError('ProfileId must be a canonical profile identifier');
    }
    this.value = value;
    Object.freeze(this);
  }
  toString() { return this.value; }
}

/** Monotonic generation fence for profile-bound work. */
export class ProfileGeneration {
  constructor(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('ProfileGeneration must be a non-negative safe integer');
    this.value = value;
    Object.freeze(this);
  }
  toString() { return String(this.value); }
}

/** Catalog-only representation; intentionally excludes credentials and key material. */
export class ProfileCatalogEntry {
  constructor({ cloudUserId, displayLabel, migrationState = 'unmigrated', generation = 0 }) {
    if (typeof cloudUserId !== 'string' || cloudUserId.trim().length === 0) throw new TypeError('cloudUserId is required');
    if (Buffer.byteLength(cloudUserId) > 256) throw new TypeError('cloudUserId is too long');
    if (typeof displayLabel !== 'string') throw new TypeError('displayLabel is required');
    if (!['unmigrated', 'pending', 'complete', 'failed'].includes(migrationState)) throw new TypeError('migrationState is invalid');
    const digest = createHash('sha256').update(cloudUserId, 'utf8').digest('hex');
    this.profileId = new ProfileId(`profile_${digest}`);
    this.cloudUserId = cloudUserId;
    // PostgreSQL identifiers are limited to 63 bytes; use 192 hash bits plus the fixed prefix.
    this.dbIdentifier = `${DATABASE_PREFIX}${digest.slice(0, 48)}`;
    this.displayLabel = displayLabel;
    this.migrationState = migrationState;
    this.generation = new ProfileGeneration(generation);
    Object.freeze(this);
  }

  toJSON() {
    return {
      profileId: this.profileId.value,
      cloudUserId: this.cloudUserId,
      dbIdentifier: this.dbIdentifier,
      displayLabel: this.displayLabel,
      migrationState: this.migrationState,
      generation: this.generation.value,
    };
  }
}

/** Pure identity/generation/collision checks; no storage, logging or switching side effects. */
export class ProfileBoundary {
  resolve(entries, profileId) {
    if (!Array.isArray(entries)) throw new TypeError('Profile catalog must be an array');
    if (typeof profileId !== 'string' || profileId.length === 0) throw new Error('Missing profile id');
    const matches = entries.filter(entry => entry?.profileId?.value === profileId || entry?.profileId === profileId);
    if (matches.length === 0) throw new Error('Unknown profile id');
    if (matches.length !== 1) throw new Error('Ambiguous profile id');
    return matches[0];
  }

  assertCurrent(requestGeneration, activeGeneration) {
    const request = requestGeneration instanceof ProfileGeneration ? requestGeneration.value : requestGeneration;
    const active = activeGeneration instanceof ProfileGeneration ? activeGeneration.value : activeGeneration;
    if (!Number.isSafeInteger(request) || !Number.isSafeInteger(active)) throw new Error('Missing profile generation');
    if (request !== active) throw new Error('Stale profile generation');
  }

  assertCollisionSafe(entries) {
    if (!Array.isArray(entries)) throw new TypeError('Profile catalog must be an array');
    const byDatabase = new Map();
    for (const entry of entries) {
      const { cloudUserId, dbIdentifier } = entry ?? {};
      if (typeof cloudUserId !== 'string' || !cloudUserId || typeof dbIdentifier !== 'string' ||
          !dbIdentifier.startsWith(DATABASE_PREFIX) || !DATABASE_SUFFIX.test(dbIdentifier)) {
        throw new Error('Invalid profile database identifier');
      }
      const existing = byDatabase.get(dbIdentifier);
      if (existing !== undefined && existing !== cloudUserId) throw new Error('Profile database identifier collision');
      const digest = createHash('sha256').update(cloudUserId, 'utf8').digest('hex').slice(0, 48);
      if (dbIdentifier !== `${DATABASE_PREFIX}${digest}`) throw new Error('Profile database identifier does not match its Cloud identity');
      byDatabase.set(dbIdentifier, cloudUserId);
    }
  }

  serializeLogDto({ profileId, generation, event }) {
    const id = profileId instanceof ProfileId ? profileId.value : profileId?.value ?? profileId;
    const value = generation instanceof ProfileGeneration ? generation.value : generation?.value ?? generation;
    if (typeof id !== 'string' || !Number.isSafeInteger(value) || typeof event !== 'string') throw new Error('Invalid profile log DTO');
    return Object.freeze({ profileId: id, generation: value, event });
  }

  serializeCatalogEntry(entry) {
    const dto = entry instanceof ProfileCatalogEntry ? entry.toJSON() : {
      profileId: entry.profileId?.value ?? entry.profileId,
      cloudUserId: entry.cloudUserId,
      dbIdentifier: entry.dbIdentifier,
      displayLabel: entry.displayLabel,
      migrationState: entry.migrationState,
      generation: entry.generation?.value ?? entry.generation,
    };
    for (const key of Object.keys(dto)) if (SECRET_FIELD.test(key)) throw new Error('Profile catalog DTO contains a forbidden field');
    return Object.freeze(dto);
  }
}
