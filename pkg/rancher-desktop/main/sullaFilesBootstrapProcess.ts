/** Dedicated Electron process for OS-key unwrap and direct sealed delivery to Files. */
import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { app, safeStorage, session } from 'electron';

import {
  FILES_BOOTSTRAP_DESTINATION,
  filesChallengeProofInput,
  filesServerProofInput,
  filesSessionContext,
  filesUnlockProofInput,
  type FilesBootstrapChallengeResponse,
  type FilesBootstrapUnlockResponse,
} from '../../../services/sulla-files/src/bootstrapProtocol';
import { SullaFilesKeychain } from './sullaFilesKeychain';
import { verifyVaultCertificate } from './vaultTlsVerifier';

const API = 'https://127.0.0.1:30124';
const CALLER_ID = 'sulla-desktop-files-bootstrap';

function requiredEnv(name:string):string {
  const value = process.env[name]; if (!value) throw new Error(`${ name } is required`); return value;
}
function requiredAbsolutePath(name:string):string {
  const value = requiredEnv(name);
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${ name } is invalid`);
  return value;
}
function hmac(key:Buffer, value:string):string { return createHmac('sha256', key).update(value, 'utf8').digest('base64url') }
function equal(left:string, right:string):boolean {
  const a = Buffer.from(left, 'base64url'); const b = Buffer.from(right, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}
function unwrapIdentity():Buffer {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS key storage unavailable');
  return Buffer.from(safeStorage.decryptString(fs.readFileSync(requiredEnv('SULLA_FILES_BOOTSTRAP_IDENTITY_PATH'))), 'utf8');
}
function configureTls():void {
  const expected = fs.readFileSync(requiredEnv('SULLA_FILES_TLS_FINGERPRINT_PATH'), 'utf8').replaceAll(':', '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Files TLS fingerprint invalid');
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(verifyVaultCertificate(request.hostname, request.certificate.data, expected) ? 0 : -2);
  });
}
async function post<T>(requestPath:string, body:unknown):Promise<T> {
  const response = await session.defaultSession.fetch(`${ API }${ requestPath }`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as T & { code?:string };
  if (!response.ok) throw new Error(typeof result.code === 'string' ? result.code : 'FILES_BOOTSTRAP_FAILED');
  return result;
}

async function bootstrap():Promise<FilesBootstrapUnlockResponse> {
  const keychain = new SullaFilesKeychain(
    requiredEnv('SULLA_FILES_MASTER_KEY_PATH'), async() => safeStorage, undefined,
    [
      { sourcePath: requiredEnv('SULLA_FILES_LEGACY_PRIMARY_PATH'), archivePath: requiredEnv('SULLA_FILES_LEGACY_PRIMARY_ARCHIVE_PATH') },
      { sourcePath: requiredEnv('SULLA_FILES_LEGACY_QUARANTINE_PATH'), archivePath: requiredEnv('SULLA_FILES_LEGACY_QUARANTINE_ARCHIVE_PATH') },
    ],
  );
  const identity = unwrapIdentity(); const hasMasterBlob = await keychain.hasMaster();
  let master:Buffer | undefined; let sessionKey:Buffer | undefined; let clear:Buffer | undefined;
  const legacy:Buffer[] = [];
  try {
    const clientNonce = randomBytes(32).toString('base64url');
    const challenge = await post<FilesBootstrapChallengeResponse>('/v1/bootstrap/challenge', {
      callerId: CALLER_ID, destination: FILES_BOOTSTRAP_DESTINATION, clientNonce, hasMasterBlob,
      clientProof: hmac(identity, filesChallengeProofInput(CALLER_ID, clientNonce, hasMasterBlob)),
    });
    if (!challenge || challenge.destination !== FILES_BOOTSTRAP_DESTINATION || typeof challenge.serverProof !== 'string' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(challenge.challengeId) || !/^[A-Za-z0-9_-]{32,128}$/.test(challenge.serverNonce) ||
        !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= Date.now() ||
        !['existing', 'create-new', 'recover'].includes(challenge.disposition)) throw new Error('FILES_BOOTSTRAP_CHALLENGE_INVALID');
    const expected = hmac(identity, filesServerProofInput(
      CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
      challenge.disposition, hasMasterBlob,
    ));
    if (!equal(challenge.serverProof, expected)) throw new Error('FILES_BOOTSTRAP_SERVER_INVALID');
    if (challenge.disposition === 'existing') {
      if (!hasMasterBlob) throw new Error('FILES_MASTER_BLOB_REQUIRED');
      master = await keychain.openExistingMaster();
    } else {
      if (hasMasterBlob) throw new Error('FILES_BOOTSTRAP_DISPOSITION_INVALID');
      master = keychain.generateMaster();
      // Close the crash window before Files can commit anything under this key.
      // Exclusive creation plus file and parent fsync makes this the canonical
      // retry key without ever replacing an existing OS blob.
      await keychain.persistMaster(master);
    }
    legacy.push(...await keychain.legacyCandidates());
    const context = filesSessionContext(
      CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
      challenge.disposition, hasMasterBlob,
    );
    sessionKey = createHmac('sha256', identity).update(context, 'utf8').digest();
    clear = Buffer.from(JSON.stringify({
      masterKey: master.toString('base64url'), legacyMasterKeys: legacy.map(key => key.toString('base64url')),
    }), 'utf8');
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    const packed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    const sealedUnlock = packed.toString('base64url'); packed.fill(0); ciphertext.fill(0); nonce.fill(0);
    const result = await post<FilesBootstrapUnlockResponse>('/v1/bootstrap/unlock', {
      callerId: CALLER_ID, destination: FILES_BOOTSTRAP_DESTINATION, challengeId: challenge.challengeId, sealedUnlock,
      clientProof: hmac(identity, filesUnlockProofInput(
        CALLER_ID, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt,
        challenge.disposition, hasMasterBlob, sealedUnlock,
      )),
    });
    if (result.state !== 'unlocked' || !['clear', 'imported'].includes(result.legacyImport) || typeof result.recovered !== 'boolean') {
      throw new Error('FILES_BOOTSTRAP_RESPONSE_INVALID');
    }
    // Converge retirement after any authenticated success. If a prior response
    // was lost after Files committed its import, the next bootstrap still
    // archives and removes the raw legacy source safely.
    if (result.legacyImport === 'imported') await keychain.retireConsumedLegacySources();
    return result;
  } finally {
    identity.fill(0); master?.fill(0); sessionKey?.fill(0); clear?.fill(0);
    for (const key of legacy) key.fill(0);
  }
}

export async function runSullaFilesBootstrapProcess():Promise<never> {
  try {
    app.setName('Sulla Desktop');
    app.setPath('userData', requiredAbsolutePath('SULLA_FILES_USER_DATA_PATH'));
    await app.whenReady(); configureTls(); const result = await bootstrap();
    process.stdout.write(`${ JSON.stringify({ ok: true, state: result.state, legacyImport: result.legacyImport, recovered: result.recovered }) }\n`);
    app.exit(0);
  } catch (error) {
    const message = (error as Error).message;
    const code = /^FILES_[A-Z0-9_]{1,80}$/.test(message) ? message : 'FILES_BOOTSTRAP_FAILED';
    process.stdout.write(`${ JSON.stringify({ ok: false, code }) }\n`); app.exit(1);
  }
  return await new Promise<never>(() => undefined);
}
