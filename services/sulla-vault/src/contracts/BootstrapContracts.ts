// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Bootstrap and cache-update handshake wire shapes and the exact HMAC / key-derivation input strings. */
export interface BootstrapChallengeRequest {
  callerId:    string;
  clientNonce: string;
  /** HMAC over callerId + clientNonce; the installation secret is never transmitted. */
  clientProof: string;
}

export interface BootstrapChallengeResponse {
  challengeId: string;
  serverNonce: string;
  serverProof: string;
  expiresAt:   number;
}

export interface BootstrapUnlockRequest {
  callerId:    string;
  challengeId: string;
  clientProof: string;
  /** AES-256-GCM sealed JSON {masterKey,legacyVmk?}; key is derived from both nonces and the installation secret. */
  sealedUnlock: string;
}

export interface BootstrapUnlockResponse {
  state: LocalVaultState;
}

export const BOOTSTRAP_PROTOCOL_VERSION = 1 as const;
/**
 * Both peers use the UTF-8 bytes of the exact base64url installation token
 * string as the HMAC key. They MUST NOT base64-decode that token first. The
 * base64-decoded values inside sealedUnlock are vault key material and are a
 * separate trust domain.
 */
export const BOOTSTRAP_HMAC_KEY_ENCODING = 'utf8-base64url-token-string' as const;

export function bootstrapChallengeProofInput(callerId: string, clientNonce: string): string {
  return `challenge:${ callerId }:${ clientNonce }`;
}

export function bootstrapServerProofInput(
  callerId: string, clientNonce: string, serverNonce: string, challengeId: string, expiresAt: number,
): string {
  return `server:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }`;
}

export function bootstrapSessionKeyInput(
  callerId: string, clientNonce: string, serverNonce: string, challengeId: string, expiresAt: number,
): string {
  return `session:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }`;
}

export function bootstrapUnlockProofInput(
  callerId: string, clientNonce: string, serverNonce: string, challengeId: string, expiresAt: number, sealedSha256: string,
): string {
  return `unlock:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }:${ sealedSha256 }`;
}

/**
 * Cache update is a separate, domain-separated use of the bootstrap identity.
 * The helper authenticates the service proof before asking for the staged key.
 */
export function cacheUpdateChallengeProofInput(callerId: string, clientNonce: string): string {
  return `cache-challenge:${ callerId }:${ clientNonce }`;
}

export function cacheUpdateServerProofInput(
  callerId: string, clientNonce: string, serverNonce: string, challengeId: string, expiresAt: number,
): string {
  return `cache-server:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }`;
}

export function cacheUpdateSessionKeyInput(
  callerId: string, clientNonce: string, serverNonce: string, challengeId: string, expiresAt: number,
): string {
  return `cache-session:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }`;
}

export function cacheUpdateFetchProofInput(
  callerId: string, clientNonce: string, serverNonce: string, challengeId: string, expiresAt: number,
  sealedLegacySha256 = '-',
): string {
  return `cache-fetch:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }:${ sealedLegacySha256 }`;
}

export type CacheUpdateChallengeRequest = BootstrapChallengeRequest;
export type CacheUpdateChallengeResponse = BootstrapChallengeResponse;

export interface CacheUpdateFetchRequest {
  callerId:    string;
  challengeId: string;
  clientProof: string;
  /** Optional AES-256-GCM sealed 32-byte legacy VMK, accepted only while migration is required. */
  sealedLegacyVmk?: string;
}

export interface CacheUpdateFetchResponse {
  /** AES-256-GCM sealed JSON {masterKey}; only the isolated bootstrap helper can derive the session key. */
  sealedMaster: string;
}
