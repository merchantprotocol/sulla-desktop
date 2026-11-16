// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import {
  bootstrapChallengeProofInput,
  bootstrapServerProofInput,
  bootstrapSessionKeyInput,
  bootstrapUnlockProofInput,
  cacheUpdateChallengeProofInput,
  cacheUpdateFetchProofInput,
  cacheUpdateServerProofInput,
  cacheUpdateSessionKeyInput,
  type LocalVaultState,
} from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';
import { CHALLENGE_RATE_LIMIT, CHALLENGE_RATE_WINDOW_MS, CHALLENGE_TTL_MS } from './LocalAuthorityLimits.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * The OS-helper bootstrap protocol: HMAC-proved challenges, the sealed unlock hand-off, and the
 * one-shot cache-update fetch that re-seals a newly derived master key for the helper.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class BootstrapUnlockService {
  constructor(private readonly host: LocalAuthorityHost) {}

  createCacheUpdateChallenge(callerId: string, clientNonce: string, clientProof: string): {
    challengeId: string; serverNonce: string; serverProof: string; expiresAt: number;
  } {
    this.host.expireStagedCacheUpdate();
    if (!this.host.stagedCacheUpdate || callerId !== this.host.config.bootstrapServiceId ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(clientNonce) ||
        !LocalAuthorityCrypto.constantEqual(clientProof, LocalAuthorityCrypto.hmac(this.host.bootstrapToken(), cacheUpdateChallengeProofInput(callerId, clientNonce)))) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Cache helper proof is invalid');
    }
    const challengeId = randomBytes(32).toString('base64url');
    const serverNonce = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(Date.now() + CHALLENGE_TTL_MS, this.host.stagedCacheUpdate.expiresAt);
    this.host.cacheChallenges.set(challengeId, { callerId, clientNonce, serverNonce, expiresAt });
    return {
      challengeId,
      serverNonce,
      serverProof: LocalAuthorityCrypto.hmac(this.host.bootstrapToken(), cacheUpdateServerProofInput(callerId, clientNonce, serverNonce, challengeId, expiresAt)),
      expiresAt,
    };
  }

  fetchCacheUpdate(input: { callerId: string; challengeId: string; clientProof: string; sealedLegacyVmk?: string }): { sealedMaster: string } {
    this.host.expireStagedCacheUpdate();
    const challenge = this.host.cacheChallenges.get(input.challengeId);
    this.host.cacheChallenges.delete(input.challengeId);
    const staged = this.host.stagedCacheUpdate;
    const sealedLegacySha256 = input.sealedLegacyVmk
      ? createHash('sha256').update(input.sealedLegacyVmk).digest('base64url')
      : '-';
    if (!challenge || !staged || challenge.callerId !== input.callerId || challenge.expiresAt <= Date.now() ||
        staged.generation !== this.host.generation ||
        !LocalAuthorityCrypto.constantEqual(input.clientProof, LocalAuthorityCrypto.hmac(this.host.bootstrapToken(), cacheUpdateFetchProofInput(
          input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt, sealedLegacySha256)))) {
      throw new LocalVaultError('invalid_bootstrap_challenge', 401, 'Cache update challenge is invalid or expired');
    }
    const sessionKey = createHmac('sha256', this.host.bootstrapToken())
      .update(cacheUpdateSessionKeyInput(input.callerId, challenge.clientNonce, challenge.serverNonce,
        input.challengeId, challenge.expiresAt)).digest();
    const clear = Buffer.from(JSON.stringify({ masterKey: staged.masterKey.toString('base64url') }));
    let legacyPacked: Buffer | undefined;
    let legacyVmk: Buffer | undefined;
    try {
      if (input.sealedLegacyVmk) {
        if (this.host.migrationState !== 'migration_required') {
          throw new LocalVaultError('invalid_unlock_material', 409, 'Legacy migration material is not expected');
        }
        legacyPacked = Buffer.from(input.sealedLegacyVmk, 'base64url');
        if (legacyPacked.byteLength < 29) throw new LocalVaultError('invalid_unlock_material', 400, 'Sealed legacy material is truncated');
        const decipher = createDecipheriv('aes-256-gcm', sessionKey, legacyPacked.subarray(0, 12));
        decipher.setAuthTag(legacyPacked.subarray(12, 28));
        legacyVmk = Buffer.concat([decipher.update(legacyPacked.subarray(28)), decipher.final()]);
        if (legacyVmk.byteLength !== 32) throw new LocalVaultError('invalid_unlock_material', 400, 'Legacy material has an invalid length');
        this.host.requireGeneration(staged.generation);
        this.host.keys!.legacyVmk?.fill(0);
        this.host.keys!.legacyVmk = Buffer.from(legacyVmk);
      }
      const nonce = randomBytes(12);
      return { sealedMaster: LocalAuthorityCrypto.sealCacheUpdate(clear, sessionKey, nonce) };
    } finally {
      clear.fill(0);
      sessionKey.fill(0);
      staged.masterKey.fill(0);
      this.host.stagedCacheUpdate = null;
      this.host.cacheChallenges.clear();
      legacyPacked?.fill(0);
      legacyVmk?.fill(0);
    }
  }

  createChallenge(callerId: string, clientNonce: string, clientProof: string): {
    challengeId: string; serverNonce: string; serverProof: string; expiresAt: number;
  } {
    const now = Date.now();
    for (const [id, challenge] of this.host.challenges) if (challenge.expiresAt <= now) this.host.challenges.delete(id);
    if (callerId !== this.host.config.bootstrapServiceId || !/^[A-Za-z0-9_-]{32,128}$/.test(clientNonce) ||
        !LocalAuthorityCrypto.constantEqual(clientProof, LocalAuthorityCrypto.hmac(this.host.bootstrapToken(), bootstrapChallengeProofInput(callerId, clientNonce)))) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Bootstrap service proof is invalid');
    }
    const current = this.host.challengeRate.get(callerId);
    if (!current || current.resetAt <= now) this.host.challengeRate.set(callerId, { count: 1, resetAt: now + CHALLENGE_RATE_WINDOW_MS });
    else {
      if (current.count >= CHALLENGE_RATE_LIMIT) throw new LocalVaultError('invalid_service_identity', 429, 'Bootstrap challenge rate exceeded');
      current.count += 1;
    }
    const challengeId = randomBytes(32).toString('base64url');
    const serverNonce = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    this.host.challenges.set(challengeId, { callerId, clientNonce, serverNonce, expiresAt });
    return {
      challengeId,
      serverNonce,
      serverProof: LocalAuthorityCrypto.hmac(this.host.bootstrapToken(), bootstrapServerProofInput(callerId, clientNonce, serverNonce, challengeId, expiresAt)),
      expiresAt,
    };
  }

  async unlock(input: {
    callerId: string;
    challengeId: string;
    clientProof: string;
    sealedUnlock: string;
  }): Promise<{ state: LocalVaultState }> {
    return this.host.runSecurityOperation(async() => {
    const attemptGeneration = this.host.generation;
    const challenge = this.host.challenges.get(input.challengeId);
    this.host.challenges.delete(input.challengeId);
    const sealedDigest = createHash('sha256').update(input.sealedUnlock).digest('base64url');
    if (!challenge || challenge.callerId !== input.callerId || challenge.expiresAt <= Date.now() ||
        !LocalAuthorityCrypto.constantEqual(input.clientProof, LocalAuthorityCrypto.hmac(this.host.bootstrapToken(), bootstrapUnlockProofInput(
          input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt, sealedDigest)))) {
      throw new LocalVaultError('invalid_bootstrap_challenge', 401, 'Bootstrap challenge is invalid or expired');
    }
    const sessionKey = createHmac('sha256', this.host.bootstrapToken())
      .update(bootstrapSessionKeyInput(input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt)).digest();
    const sealed = Buffer.from(input.sealedUnlock, 'base64url');
    let clear: Buffer | undefined;
    let material: { masterKey?: unknown; legacyVmk?: unknown };
    try {
      if (sealed.byteLength < 29) throw new Error('sealed payload is truncated');
      const decipher = createDecipheriv('aes-256-gcm', sessionKey, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      clear = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
      material = JSON.parse(clear.toString('utf8')) as { masterKey?: unknown; legacyVmk?: unknown };
    } catch {
      throw new LocalVaultError('invalid_unlock_material', 400, 'Sealed unlock material is invalid');
    } finally {
      sessionKey.fill(0);
      clear?.fill(0);
      sealed.fill(0);
    }
    if (typeof material.masterKey !== 'string' || (material.legacyVmk !== undefined && typeof material.legacyVmk !== 'string')) {
      throw new LocalVaultError('invalid_unlock_material', 400, 'Sealed unlock material has an invalid shape');
    }
    const masterKey = Buffer.from(material.masterKey, 'base64url');
    const legacyVmk = typeof material.legacyVmk === 'string' ? Buffer.from(material.legacyVmk, 'base64url') : undefined;
    if (masterKey.byteLength !== 32 || (legacyVmk && legacyVmk.byteLength !== 32)) {
      masterKey.fill(0);
      legacyVmk?.fill(0);
      throw new LocalVaultError('invalid_unlock_material', 400, 'Unlock material has an invalid length');
    }

    try {
      return await this.host.activateMasterKey(masterKey, legacyVmk, { authority: 'container', version: 1 }, attemptGeneration);
    } finally {
      masterKey.fill(0);
      if (legacyVmk && this.host.keys?.legacyVmk !== legacyVmk) legacyVmk.fill(0);
    }
    });
  }
}
