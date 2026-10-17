/**
 * Dedicated bootstrap-only Electron main process.
 *
 * This module is selected by bootstrapEntry before the normal Desktop graph is
 * imported. It unwraps OS-protected material, mutually authenticates the vault
 * service, performs one sealed handoff, zeros buffers, and exits. It exposes no
 * IPC server and never sends key bytes to its parent process.
 */
import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { app, safeStorage, session } from 'electron';

import {
  bootstrapChallengeProofInput,
  bootstrapServerProofInput,
  bootstrapSessionKeyInput,
  cacheUpdateChallengeProofInput,
  cacheUpdateFetchProofInput,
  cacheUpdateServerProofInput,
  cacheUpdateSessionKeyInput,
  type BootstrapChallengeResponse,
  type BootstrapUnlockResponse,
  type CacheUpdateChallengeResponse,
  type CacheUpdateFetchResponse,
} from '../../../services/sulla-vault/src/contracts';
import { bootstrapUnlockProofInputForSealed } from '../../../services/sulla-vault/src/bootstrapProof';
import { verifyVaultCertificate } from './vaultTlsVerifier';
import { openVaultCacheEnvelope, sealLegacyVaultKey } from './vaultCacheEnvelope';

const API = 'https://127.0.0.1:30135';
const CALLER_ID = 'sulla-desktop-bootstrap';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${ name } is required for the vault bootstrap helper`);
  return value;
}

function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

function equalBase64Url(left: string, right: string): boolean {
  const a = Buffer.from(left, 'base64url');
  const b = Buffer.from(right, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

function unwrapString(path: string): string {
  if (!fs.existsSync(path)) throw new Error(`OS-protected vault material is unavailable (${ path })`);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS key storage is unavailable');
  return safeStorage.decryptString(fs.readFileSync(path));
}

function unwrapKey(path: string): Buffer {
  return Buffer.from(unwrapString(path), 'base64url');
}

function writeFileAtomic(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${ filePath }.tmp-${ process.pid }`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').trim().toLowerCase();
}

function configurePinnedTls(): void {
  const expected = normalizeFingerprint(fs.readFileSync(requiredEnv('SULLA_VAULT_TLS_FINGERPRINT_PATH'), 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Vault TLS fingerprint is missing or invalid');
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(verifyVaultCertificate(request.hostname, request.certificate.data, expected) ? 0 : -2);
  });
}

async function jsonRequest<T>(requestPath: string, body: unknown): Promise<T> {
  const response = await session.defaultSession.fetch(`${ API }${ requestPath }`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(result.error ?? result.message ?? `Vault bootstrap failed (${ response.status })`);
  return result;
}

async function bootstrap(): Promise<BootstrapUnlockResponse> {
  // Provisioning stores one canonical base64url token string in Keychain and
  // passes that same string to the service. HMAC keys are UTF-8 bytes on both sides.
  const identity = Buffer.from(unwrapString(requiredEnv('SULLA_VAULT_BOOTSTRAP_IDENTITY_PATH')), 'utf8');
  let masterKey: Buffer | undefined;
  let legacyVmk: Buffer | undefined;
  let sessionKey: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const clientNonce = randomBytes(32).toString('base64url');
    const challenge = await jsonRequest<BootstrapChallengeResponse>('/v1/desktop/bootstrap/challenge', {
      callerId: CALLER_ID,
      clientNonce,
      clientProof: hmac(identity, bootstrapChallengeProofInput(CALLER_ID, clientNonce)),
    });
    const expectedServerProof = hmac(identity, bootstrapServerProofInput(
      CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
    ));
    if (challenge.expiresAt <= Date.now() || !equalBase64Url(challenge.serverProof, expectedServerProof)) {
      throw new Error('Vault server identity proof is invalid or expired');
    }

    masterKey = unwrapKey(requiredEnv('SULLA_VAULT_MASTER_KEY_PATH'));
    const legacyPath = process.env.SULLA_VAULT_LEGACY_VMK_PATH;
    if (legacyPath && fs.existsSync(legacyPath)) legacyVmk = unwrapKey(legacyPath);
    if (masterKey.byteLength !== 32 || (legacyVmk && legacyVmk.byteLength !== 32)) {
      throw new Error('Unwrapped vault key material has an invalid length');
    }

    sessionKey = createHmac('sha256', identity).update(bootstrapSessionKeyInput(
      CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
    ), 'utf8').digest();
    plaintext = Buffer.from(JSON.stringify({
      masterKey: masterKey.toString('base64url'),
      ...(legacyVmk ? { legacyVmk: legacyVmk.toString('base64url') } : {}),
    }), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const sealedUnlock = sealed.toString('base64url');
    sealed.fill(0);

    return await jsonRequest<BootstrapUnlockResponse>('/v1/desktop/bootstrap/unlock', {
      callerId: CALLER_ID,
      challengeId: challenge.challengeId,
      sealedUnlock,
      clientProof: hmac(identity, bootstrapUnlockProofInputForSealed(
        CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt, sealedUnlock,
      )),
    });
  } finally {
    identity.fill(0);
    masterKey?.fill(0);
    legacyVmk?.fill(0);
    sessionKey?.fill(0);
    plaintext?.fill(0);
  }
}

async function updateMasterCache(): Promise<void> {
  const identity = Buffer.from(unwrapString(requiredEnv('SULLA_VAULT_BOOTSTRAP_IDENTITY_PATH')), 'utf8');
  let sessionKey: Buffer | undefined;
  let masterKey: Buffer | undefined;
  let legacyVmk: Buffer | undefined;
  try {
    const clientNonce = randomBytes(32).toString('base64url');
    const challenge = await jsonRequest<CacheUpdateChallengeResponse>('/v1/desktop/cache/challenge', {
      callerId: CALLER_ID,
      clientNonce,
      clientProof: hmac(identity, cacheUpdateChallengeProofInput(CALLER_ID, clientNonce)),
    });
    const expectedServerProof = hmac(identity, cacheUpdateServerProofInput(
      CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
    ));
    if (challenge.expiresAt <= Date.now() || !equalBase64Url(challenge.serverProof, expectedServerProof)) {
      throw new Error('Vault cache-update server proof is invalid or expired');
    }
    sessionKey = createHmac('sha256', identity).update(cacheUpdateSessionKeyInput(
      CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
    ), 'utf8').digest();
    const legacyPath = process.env.SULLA_VAULT_LEGACY_VMK_PATH;
    if (legacyPath && fs.existsSync(legacyPath)) {
      legacyVmk = unwrapKey(legacyPath);
      if (legacyVmk.byteLength !== 32) throw new Error('Legacy vault key has an invalid length');
    }
    const sealedLegacyVmk = legacyVmk ? sealLegacyVaultKey(legacyVmk, sessionKey) : undefined;
    const sealedLegacySha256 = sealedLegacyVmk
      ? createHash('sha256').update(sealedLegacyVmk).digest('base64url')
      : '-';
    const response = await jsonRequest<CacheUpdateFetchResponse>('/v1/desktop/cache/fetch', {
      callerId: CALLER_ID,
      challengeId: challenge.challengeId,
      ...(sealedLegacyVmk ? { sealedLegacyVmk } : {}),
      clientProof: hmac(identity, cacheUpdateFetchProofInput(
        CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt, sealedLegacySha256,
      )),
    });
    masterKey = openVaultCacheEnvelope(response.sealedMaster, sessionKey);
    const encrypted = safeStorage.encryptString(masterKey.toString('base64url'));
    try {
      writeFileAtomic(requiredEnv('SULLA_VAULT_MASTER_KEY_PATH'), encrypted);
    } finally {
      encrypted.fill(0);
    }
  } finally {
    identity.fill(0);
    sessionKey?.fill(0);
    masterKey?.fill(0);
    legacyVmk?.fill(0);
  }
}

export async function runVaultBootstrapProcess(): Promise<never> {
  try {
    await app.whenReady();
    configurePinnedTls();
    if (process.argv.includes('--sulla-vault-cache-update-helper')) {
      await updateMasterCache();
      process.stdout.write(`${ JSON.stringify({ ok: true, updated: true }) }\n`);
    } else {
      const result = await bootstrap();
      process.stdout.write(`${ JSON.stringify({ ok: true, state: result.state }) }\n`);
    }
    app.exit(0);
  } catch (error) {
    process.stdout.write(`${ JSON.stringify({ ok: false, error: (error as Error).message }) }\n`);
    app.exit(1);
  }
  return await new Promise<never>(() => undefined);
}
