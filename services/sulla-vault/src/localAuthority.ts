import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';
import https from 'node:https';
import net from 'node:net';

import pg from 'pg';

import {
  agentPolicyAllows,
  agentPolicyFromLegacyLlmAccess,
  createUserKey,
  createUserKeyPair,
  decryptWithKey,
  decryptItemText,
  deriveLoginHash,
  deriveMasterKey,
  encryptItem,
  encryptWithKey,
  unwrapUserKey,
  unwrapUserPrivateKey,
  type AgentAccessLevel,
  type AgentPolicy,
  type EncryptedEnvelope,
  type VaultItemPlaintext,
} from '@sulla/vault-crypto';

import { makeLoginVerifier, verifyLoginHash } from './auth.js';
import { validateCatalogRequest } from './catalogPolicy.js';
import { enterpriseGatewayOrigin, validateEnterpriseGatewayHttp } from './gatewayPolicy.js';
import { trustedOriginsForIntegration, validateOperation } from './operationPolicy.js';
import { validateOAuthDestination } from './oauthPolicy.js';
import { pinnedLookup } from './pinnedLookup.js';
import { createRelayId, DefaultVaultRelayManager } from './relays.js';
import { buildTranscriptionProviderRequest } from './transcriptionPolicy.js';

import type { VaultConfig } from './config.js';
import type {
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  BrokerRelaySendRequest,
  HumanBackupEnvelope,
  LegacyMigrationResponse,
  LocalVaultState,
} from './contracts.js';
import type { VaultRelayEvent, VaultRelayManager } from './relays.js';
import {
  bootstrapChallengeProofInput,
  bootstrapServerProofInput,
  bootstrapSessionKeyInput,
  bootstrapUnlockProofInput,
  cacheUpdateChallengeProofInput,
  cacheUpdateFetchProofInput,
  cacheUpdateServerProofInput,
  cacheUpdateSessionKeyInput,
} from './contracts.js';
import type { Database } from './db.js';

const CHALLENGE_TTL_MS = 30_000;
const CACHE_UPDATE_TTL_MS = 60_000;
const CHALLENGE_RATE_WINDOW_MS = 60_000;
const CHALLENGE_RATE_LIMIT = 10;
const APPROVAL_TTL_MS = 2 * 60_000;
const HUMAN_SESSION_TTL_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TRANSCRIPTION_REQUEST_BYTES = 17 * 1024 * 1024;
const MAX_STREAM_BYTES = 25 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const LEGACY_PREFIX = '$VAULT$';
const SAFE_INTEGRATION_METADATA_FIELDS = new Set([
  'account_label', 'connection_status', 'connected_at', 'last_sync_at', 'base_url', 'server_url',
  'gateway_url', 'provider', 'provider_id', 'model', 'llm_access', 'client_id', 'oauth_client_id',
  'expires_at', 'token_type', 'scope',
]);
const CREDENTIAL_PROPERTY_PATTERN = /(?:^|_)(?:token|key|secret|password|credential)$/i;

function safeIntegrationMetadata(
  source: Record<string, unknown>,
): Record<string, string> {
  const secrets = Object.entries(source)
    .filter(([name, value]) => CREDENTIAL_PROPERTY_PATTERN.test(name) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value as string);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!SAFE_INTEGRATION_METADATA_FIELDS.has(name) || typeof value !== 'string') continue;
    if (name === 'base_url' || name === 'server_url' || name === 'gateway_url') {
      try {
        const parsed = new URL(value);
        if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== 'https:') continue;
        if (name === 'gateway_url') {
          output[name] = parsed.origin;
          continue;
        }
      } catch { continue; }
    }
    output[name] = redact(value, secrets);
  }
  return output;
}

const { Pool } = pg;

function sealCacheUpdate(clear: Buffer, key: Buffer, nonce: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  ciphertext.fill(0);
  try {
    return sealed.toString('base64url');
  } finally {
    sealed.fill(0);
  }
}

function serializeBrokerBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
}

export class LocalVaultError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'LocalVaultError';
  }
}

interface Challenge {
  callerId:    string;
  clientNonce: string;
  serverNonce: string;
  expiresAt:   number;
}

interface StagedCacheUpdate {
  masterKey:  Buffer;
  expiresAt:  number;
  generation: number;
}

interface HumanSession {
  csrf:      string;
  expiresAt: number;
  phase:     'pre-unlock' | 'unlocked';
}

interface UnlockedKeys {
  userId:     string;
  publicKey:  string;
  userKey:    Uint8Array;
  privateKey: Uint8Array;
  legacyVmk?: Buffer;
}

interface ItemRow {
  id:                     string;
  owner_user_id:          string | null;
  collection_id:          string | null;
  ciphertext:             EncryptedEnvelope;
  encrypted_item_key:     EncryptedEnvelope;
  agent_policy:           AgentPolicy;
  revision:               number;
  org_id?:                string | null;
  role?:                  string | null;
  can_use_by_agents?:     boolean | null;
  group_can_use_by_agents?: boolean | null;
}

interface LegacyIntegrationRow {
  source_kind:    'integration_value' | 'oauth_token';
  value_id:       number;
  integration_id: string;
  account_id:     string;
  property:       string;
  value:          string;
  is_default:     boolean;
  created_at:     Date | string | null;
  updated_at:     Date | string | null;
}

interface PreparedBrokerRequest {
  target:     URL & { pinnedAddress: string; pinnedFamily: 4 | 6 };
  headers:    Record<string, string>;
  body:       unknown;
  secrets:    string[];
  generation: number;
  maxRequestBytes: number;
  item?:      ItemRow;
  plaintext?: VaultItemPlaintext;
}

export interface BrokerStreamSink {
  start(status: number, headers: Record<string, string>): void;
  write(chunk: Buffer): boolean;
  onceDrain(callback: () => void): void;
  end(): void;
  destroy(error: Error): void;
  onAbort(callback: () => void): void;
}

class StreamingRedactor {
  private carry = Buffer.alloc(0);
  private readonly patterns: Buffer[];
  private readonly maxPattern: number;

  constructor(secrets: string[]) {
    const variants = new Set<string>();
    for (const secret of secrets) {
      if (!secret) continue;
      variants.add(secret);
      variants.add(`Bearer ${ secret }`);
      variants.add(`Bot ${ secret }`);
      variants.add(`Token ${ secret }`);
      variants.add(encodeURIComponent(secret));
    }
    this.patterns = [...variants].map(value => Buffer.from(value)).sort((a, b) => b.length - a.length);
    this.maxPattern = Math.max(1, ...this.patterns.map(pattern => pattern.length));
  }

  transform(chunk: Buffer, final = false): Buffer {
    const input = Buffer.concat([this.carry, chunk]);
    const output: Buffer[] = [];
    const stop = final ? input.length : Math.max(0, input.length - this.maxPattern + 1);
    let index = 0;
    while (index < stop) {
      const match = this.patterns.find(pattern => index + pattern.length <= input.length && input.subarray(index, index + pattern.length).equals(pattern));
      if (match) {
        output.push(Buffer.from('[REDACTED]'));
        index += match.length;
      } else {
        output.push(input.subarray(index, index + 1));
        index += 1;
      }
    }
    this.carry = final ? Buffer.alloc(0) : Buffer.from(input.subarray(index));
    return Buffer.concat(output);
  }

  flush(): Buffer {
    return this.transform(Buffer.alloc(0), true);
  }
}

export const localAuthorityTestHooks = {
  operationDigest,
  privateAddress,
  streamResponseIsBodyless,
  StreamingRedactor,
};

function streamResponseIsBodyless(method: string, status: number, contentLength: string | string[] | undefined): boolean {
  return method === 'HEAD' || [202, 204, 205, 304].includes(status) || contentLength === '0';
}

function constantEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(token: string, value: string): string {
  return createHmac('sha256', token).update(value).digest('base64url');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${ value.map(canonical).join(',') }]`;
  return `{${ Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${ JSON.stringify(key) }:${ canonical(child) }`).join(',') }}`;
}

function operationDigest(input: BrokerExecuteRequest): string {
  return createHash('sha256').update(canonical({
    claims: input.claims,
    operation: input.operation,
    ref: input.ref,
    url: input.url,
    method: input.method,
    headers: input.headers ?? {},
    body: input.body ?? null,
    bodyEncoding: input.bodyEncoding ?? null,
    injections: input.injections,
    responseType: input.responseType ?? 'json',
  })).digest('base64url');
}

function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (!net.isIPv6(address)) return true;
  const value = address.toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return privateAddress(mapped[1]);
  const expanded = expandIpv6(value);
  if (!expanded) return true;
  const first = expanded[0];
  const first32 = (BigInt(expanded[0]) << 16n) | BigInt(expanded[1]);
  // Accept only global-unicast 2000::/3 and reject documentation space.
  return (first & 0xe000) !== 0x2000 || first32 === 0x20010db8n;
}

function expandIpv6(value: string): number[] | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const output: number[] = [];
    for (const token of part.split(':')) {
      if (token.includes('.')) {
        if (!net.isIPv4(token)) return null;
        const bytes = token.split('.').map(Number);
        output.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        output.push(Number.parseInt(token, 16));
      }
    }
    return output;
  };
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? '');
  if (!left || !right) return null;
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || zeros < 0) return null;
  return [...left, ...Array(zeros).fill(0), ...right];
}

function credentialField(item: VaultItemPlaintext, field: string): string | undefined {
  return item.integration?.properties?.[field] ??
    (field === 'username' ? item.username : undefined) ??
    (['password', 'api_key', 'bearer_token', 'api_token', 'access_token', 'auth_token', 'token'].includes(field)
      ? item.password
      : undefined) ??
    item.fields?.find(candidate => candidate.name === field)?.value;
}

function redact(value: string, secrets: string[]): string {
  let next = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    next = next.split(secret).join('[REDACTED]');
  }
  return next;
}

function decryptLegacyValue(value: string, key: Buffer | undefined): string {
  if (!value.startsWith(LEGACY_PREFIX)) return value;
  if (!key) throw new LocalVaultError('migration_failed', 409, 'Legacy encrypted rows require the migration key');
  const packed = Buffer.from(value.slice(LEGACY_PREFIX.length), 'base64');
  if (packed.byteLength < 28) throw new LocalVaultError('migration_failed', 409, 'Legacy ciphertext is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

function stableLegacyFingerprint(rows: LegacyIntegrationRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(JSON.stringify([
      row.value_id, row.integration_id, row.account_id, row.property, row.value,
      row.is_default, row.created_at, row.updated_at, row.source_kind,
    ]));
    hash.update('\n');
  }
  return hash.digest('base64url');
}

function applyJsonPath(root: unknown, path: string, value: string): unknown {
  if (!path || !/^[A-Za-z0-9_.-]+$/.test(path)) throw new LocalVaultError('invalid_injection', 400, 'Invalid JSON injection path');
  const output = root && typeof root === 'object' && !Array.isArray(root) ? structuredClone(root) as Record<string, unknown> : {};
  const parts = path.split('.');
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new LocalVaultError('invalid_injection', 400, 'Unsafe JSON injection path');
  }
  let current = output;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    current[part] = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
  return output;
}

export class LocalVaultAuthority {
  private keys: UnlockedKeys | null = null;
  private generation = 0;
  private readonly inFlight = new Set<ReturnType<typeof https.request>>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly cacheChallenges = new Map<string, Challenge>();
  private readonly challengeRate = new Map<string, { count: number; resetAt: number }>();
  private readonly pendingApprovals = new Map<string, number>();
  private readonly approvals = new Map<string, { digest: string; expiresAt: number }>();
  private readonly humanSessions = new Map<string, HumanSession>();
  private readonly oauthRefreshQueues = new Map<string, Promise<void>>();
  private readonly relaySessions = new Map<string, { generation: number; controller: AbortController }>();
  private migrationState: LocalVaultState = 'locked';
  private stagedCacheUpdate: StagedCacheUpdate | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: VaultConfig,
    private readonly relayManager: VaultRelayManager = new DefaultVaultRelayManager(),
  ) {
    if (config.mode === 'desktop') {
      const credentials = [
        ['bootstrap', config.bootstrapServiceToken],
        ['control', config.controlServiceToken],
        ['approval', config.approvalServiceToken],
        ['broker', config.brokerServiceToken],
      ] as const;
      for (const [name, value] of credentials) {
        if (!value || Buffer.byteLength(value) < 32) throw new Error(`Desktop vault ${ name } credential is not configured`);
      }
      if (new Set(credentials.map(([, value]) => value)).size !== credentials.length) {
        throw new Error('Desktop vault service credentials must be distinct');
      }
    }
  }

  status(): { state: LocalVaultState; unlocked: boolean; principalId?: string; cacheUpdateRequired: boolean } {
    this.expireStagedCacheUpdate();
    return {
      state: this.keys ? this.migrationState : 'locked',
      unlocked: Boolean(this.keys),
      principalId: this.keys?.userId,
      cacheUpdateRequired: Boolean(this.stagedCacheUpdate),
    };
  }

  createCacheUpdateChallenge(callerId: string, clientNonce: string, clientProof: string): {
    challengeId: string; serverNonce: string; serverProof: string; expiresAt: number;
  } {
    this.expireStagedCacheUpdate();
    if (!this.stagedCacheUpdate || callerId !== this.config.bootstrapServiceId ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(clientNonce) ||
        !constantEqual(clientProof, hmac(this.bootstrapToken(), cacheUpdateChallengeProofInput(callerId, clientNonce)))) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Cache helper proof is invalid');
    }
    const challengeId = randomBytes(32).toString('base64url');
    const serverNonce = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(Date.now() + CHALLENGE_TTL_MS, this.stagedCacheUpdate.expiresAt);
    this.cacheChallenges.set(challengeId, { callerId, clientNonce, serverNonce, expiresAt });
    return {
      challengeId,
      serverNonce,
      serverProof: hmac(this.bootstrapToken(), cacheUpdateServerProofInput(callerId, clientNonce, serverNonce, challengeId, expiresAt)),
      expiresAt,
    };
  }

  fetchCacheUpdate(input: { callerId: string; challengeId: string; clientProof: string; sealedLegacyVmk?: string }): { sealedMaster: string } {
    this.expireStagedCacheUpdate();
    const challenge = this.cacheChallenges.get(input.challengeId);
    this.cacheChallenges.delete(input.challengeId);
    const staged = this.stagedCacheUpdate;
    const sealedLegacySha256 = input.sealedLegacyVmk
      ? createHash('sha256').update(input.sealedLegacyVmk).digest('base64url')
      : '-';
    if (!challenge || !staged || challenge.callerId !== input.callerId || challenge.expiresAt <= Date.now() ||
        staged.generation !== this.generation ||
        !constantEqual(input.clientProof, hmac(this.bootstrapToken(), cacheUpdateFetchProofInput(
          input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt, sealedLegacySha256)))) {
      throw new LocalVaultError('invalid_bootstrap_challenge', 401, 'Cache update challenge is invalid or expired');
    }
    const sessionKey = createHmac('sha256', this.bootstrapToken())
      .update(cacheUpdateSessionKeyInput(input.callerId, challenge.clientNonce, challenge.serverNonce,
        input.challengeId, challenge.expiresAt)).digest();
    const clear = Buffer.from(JSON.stringify({ masterKey: staged.masterKey.toString('base64url') }));
    let legacyPacked: Buffer | undefined;
    let legacyVmk: Buffer | undefined;
    try {
      if (input.sealedLegacyVmk) {
        if (this.migrationState !== 'migration_required') {
          throw new LocalVaultError('invalid_unlock_material', 409, 'Legacy migration material is not expected');
        }
        legacyPacked = Buffer.from(input.sealedLegacyVmk, 'base64url');
        if (legacyPacked.byteLength < 29) throw new LocalVaultError('invalid_unlock_material', 400, 'Sealed legacy material is truncated');
        const decipher = createDecipheriv('aes-256-gcm', sessionKey, legacyPacked.subarray(0, 12));
        decipher.setAuthTag(legacyPacked.subarray(12, 28));
        legacyVmk = Buffer.concat([decipher.update(legacyPacked.subarray(28)), decipher.final()]);
        if (legacyVmk.byteLength !== 32) throw new LocalVaultError('invalid_unlock_material', 400, 'Legacy material has an invalid length');
        this.requireGeneration(staged.generation);
        this.keys!.legacyVmk?.fill(0);
        this.keys!.legacyVmk = Buffer.from(legacyVmk);
      }
      const nonce = randomBytes(12);
      return { sealedMaster: sealCacheUpdate(clear, sessionKey, nonce) };
    } finally {
      clear.fill(0);
      sessionKey.fill(0);
      staged.masterKey.fill(0);
      this.stagedCacheUpdate = null;
      this.cacheChallenges.clear();
      legacyPacked?.fill(0);
      legacyVmk?.fill(0);
    }
  }

  createChallenge(callerId: string, clientNonce: string, clientProof: string): {
    challengeId: string; serverNonce: string; serverProof: string; expiresAt: number;
  } {
    const now = Date.now();
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(id);
    if (callerId !== this.config.bootstrapServiceId || !/^[A-Za-z0-9_-]{32,128}$/.test(clientNonce) ||
        !constantEqual(clientProof, hmac(this.bootstrapToken(), bootstrapChallengeProofInput(callerId, clientNonce)))) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Bootstrap service proof is invalid');
    }
    const current = this.challengeRate.get(callerId);
    if (!current || current.resetAt <= now) this.challengeRate.set(callerId, { count: 1, resetAt: now + CHALLENGE_RATE_WINDOW_MS });
    else {
      if (current.count >= CHALLENGE_RATE_LIMIT) throw new LocalVaultError('invalid_service_identity', 429, 'Bootstrap challenge rate exceeded');
      current.count += 1;
    }
    const challengeId = randomBytes(32).toString('base64url');
    const serverNonce = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    this.challenges.set(challengeId, { callerId, clientNonce, serverNonce, expiresAt });
    return {
      challengeId,
      serverNonce,
      serverProof: hmac(this.bootstrapToken(), bootstrapServerProofInput(callerId, clientNonce, serverNonce, challengeId, expiresAt)),
      expiresAt,
    };
  }

  async unlock(input: {
    callerId: string;
    challengeId: string;
    clientProof: string;
    sealedUnlock: string;
  }): Promise<{ state: LocalVaultState }> {
    const attemptGeneration = this.generation;
    const challenge = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    const sealedDigest = createHash('sha256').update(input.sealedUnlock).digest('base64url');
    if (!challenge || challenge.callerId !== input.callerId || challenge.expiresAt <= Date.now() ||
        !constantEqual(input.clientProof, hmac(this.bootstrapToken(), bootstrapUnlockProofInput(
          input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt, sealedDigest)))) {
      throw new LocalVaultError('invalid_bootstrap_challenge', 401, 'Bootstrap challenge is invalid or expired');
    }
    const sessionKey = createHmac('sha256', this.bootstrapToken())
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
      return await this.activateMasterKey(masterKey, legacyVmk, { authority: 'container', version: 1 }, attemptGeneration);
    } finally {
      masterKey.fill(0);
      if (legacyVmk && this.keys?.legacyVmk !== legacyVmk) legacyVmk.fill(0);
    }
  }

  async unlockWithPassword(password: string): Promise<{ state: LocalVaultState; cacheUpdateRequired: boolean }> {
    const attemptGeneration = this.generation;
    if (!password || password.length > 1024) throw new LocalVaultError('invalid_credentials', 400, 'Password is required');
    const existing = await this.db.query<{ kdf: {
      password?: { salt?: string; parameters?: { memoryBytes: number; operations: number } };
      salt?: string; parameters?: { memoryBytes: number; operations: number };
    } }>(
      'SELECT kdf FROM users WHERE disabled_at IS NULL LIMIT 1',
    );
    const storedKdf = existing.rows[0]?.kdf;
    const passwordKdf = storedKdf?.password?.salt
      ? storedKdf.password
      : storedKdf?.salt ? { salt: storedKdf.salt, parameters: storedKdf.parameters } : undefined;
    if (existing.rowCount && !passwordKdf?.salt) {
      throw new LocalVaultError('invalid_credentials', 409, 'This vault requires the OS-protected unlock cache');
    }
    const derived = await deriveMasterKey(password, passwordKdf?.salt, passwordKdf?.parameters);
    try {
      const result = await this.activateMasterKey(derived.key, undefined, {
        authority: 'container', version: 1, password: { salt: derived.salt, parameters: derived.parameters },
      }, attemptGeneration);
      if (existing.rowCount && !storedKdf?.password?.salt) {
        const keys = this.requireKeys();
        await this.db.query('UPDATE users SET kdf=$1,updated_at=now() WHERE id=$2', [
          { authority: 'container', version: 1, password: { salt: derived.salt, parameters: derived.parameters } }, keys.userId,
        ]);
      }
      this.stageCacheUpdate(derived.key);
      return { ...result, cacheUpdateRequired: true };
    } finally {
      derived.key.fill(0);
    }
  }

  private async activateMasterKey(
    masterKey: Uint8Array,
    legacyVmk?: Buffer,
    newAccountKdf: unknown = { authority: 'container', version: 1 },
    attemptGeneration = this.generation,
  ): Promise<{ state: LocalVaultState }> {
      const existing = await this.db.query<{
        id: string; login_hash_salt: Buffer; login_hash_verifier: Buffer; public_key: string;
        encrypted_private_key: EncryptedEnvelope; encrypted_user_key: EncryptedEnvelope;
      }>('SELECT id,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key FROM users WHERE disabled_at IS NULL LIMIT 1');

      let next: UnlockedKeys;
      if (!existing.rowCount) {
        const loginHash = await deriveLoginHash(masterKey);
        const created = await createUserKey(masterKey);
        try {
          const pair = await createUserKeyPair(created.userKey);
          const verifier = makeLoginVerifier(loginHash);
          const result = await this.db.query<{ id: string }>(
            `INSERT INTO users(email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
             VALUES ('desktop@local.sulla',$1,$2,$3,$4,$5,$6) RETURNING id`,
            [verifier.salt, verifier.verifier, pair.publicKey, pair.encryptedPrivateKey, created.encryptedUserKey,
              newAccountKdf],
          );
          next = { userId: result.rows[0].id, publicKey: pair.publicKey, userKey: created.userKey, privateKey: pair.privateKey, legacyVmk };
        } catch (error) {
          created.userKey.fill(0);
          throw error;
        }
      } else {
        const account = existing.rows[0];
        if (!verifyLoginHash(await deriveLoginHash(masterKey), account.login_hash_salt, account.login_hash_verifier)) {
          throw new LocalVaultError('invalid_credentials', 401, 'Unlock material did not match the vault');
        }
        const userKey = await unwrapUserKey(account.encrypted_user_key, masterKey);
        try {
          next = {
            userId: account.id,
            publicKey: account.public_key,
            userKey,
            privateKey: await unwrapUserPrivateKey(account.encrypted_private_key, userKey),
            legacyVmk,
          };
        } catch (error) {
          userKey.fill(0);
          throw error;
        }
      }
      if (attemptGeneration !== this.generation) {
        next.userKey.fill(0);
        next.privateKey.fill(0);
        next.legacyVmk?.fill(0);
        throw new LocalVaultError('vault_locked', 423, 'Unlock was cancelled by a concurrent lock');
      }
      this.lock();
      this.keys = next;
      this.generation += 1;
      const activeGeneration = this.generation;
      const committed = this.config.legacyDatabaseUrl
        ? await this.db.query("SELECT 1 FROM local_vault_migration_batches WHERE status='committed' LIMIT 1")
        : { rowCount: 1 };
      this.requireGeneration(activeGeneration);
      this.migrationState = committed.rowCount ? 'unlocked' : 'migration_required';
      return { state: this.migrationState };
  }

  lock(): void {
    this.generation += 1;
    for (const request of this.inFlight) request.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
    this.inFlight.clear();
    for (const relay of this.relaySessions.values()) relay.controller.abort(new Error('vault_locked'));
    this.relaySessions.clear();
    this.relayManager.closeAll('vault_locked');
    this.keys?.userKey.fill(0);
    this.keys?.privateKey.fill(0);
    this.keys?.legacyVmk?.fill(0);
    this.keys = null;
    this.migrationState = 'locked';
    this.challenges.clear();
    this.cacheChallenges.clear();
    this.challengeRate.clear();
    this.pendingApprovals.clear();
    this.approvals.clear();
    this.humanSessions.clear();
    this.stagedCacheUpdate?.masterKey.fill(0);
    this.stagedCacheUpdate = null;
  }

  createHumanSession(callerId: string, token: string | undefined): { sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked' } {
    this.requireControlIdentity(callerId, token);
    return this.issueHumanSession();
  }

  private issueHumanSession(): { sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked' } {
    const sessionId = randomBytes(32).toString('base64url');
    const session = {
      csrf: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + HUMAN_SESSION_TTL_MS,
      phase: this.keys ? 'unlocked' as const : 'pre-unlock' as const,
    };
    this.humanSessions.set(sessionId, session);
    return { sessionId, ...session };
  }

  validateHumanSession(sessionId: string | undefined, csrf?: string): HumanSession {
    const session = sessionId ? this.humanSessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.humanSessions.delete(sessionId);
      throw new LocalVaultError('invalid_human_session', 401, 'Human vault session is invalid or expired');
    }
    if (!csrf || !constantEqual(csrf, session.csrf)) {
      throw new LocalVaultError('invalid_csrf', 403, 'CSRF token is invalid');
    }
    return session;
  }

  async unlockHumanSession(sessionId: string | undefined, csrf: string | undefined, password: string): Promise<{
    sessionId: string; csrf: string; expiresAt: number; phase: 'unlocked'; state: LocalVaultState; cacheMode: 'helper-update-required';
  }> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Vault is already unlocked');
    const result = await this.unlockWithPassword(password);
    // activateMasterKey invalidates every pre-unlock grant before installing keys.
    const next = this.issueHumanSession();
    if (next.phase !== 'unlocked') throw new LocalVaultError('vault_unavailable', 503, 'Vault unlock did not establish an unlocked session');
    return { ...next, phase: 'unlocked', state: result.state, cacheMode: 'helper-update-required' };
  }

  exchangeHumanGrant(sessionId: string | undefined, csrf: string | undefined): {
    sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked';
  } {
    this.validateHumanSession(sessionId, csrf);
    this.humanSessions.delete(sessionId!);
    return this.issueHumanSession();
  }

  lockHumanSession(sessionId: string | undefined, csrf: string | undefined): {
    sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock'; state: 'locked';
  } {
    this.validateHumanSession(sessionId, csrf);
    this.lock();
    const next = this.issueHumanSession();
    if (next.phase !== 'pre-unlock') throw new LocalVaultError('vault_unavailable', 503, 'Vault did not lock');
    return { ...next, phase: 'pre-unlock', state: 'locked' };
  }

  async listHumanItems(sessionId: string | undefined, csrf: string | undefined): Promise<Array<Record<string, unknown>>> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const rows = await this.db.query<ItemRow & { item_type: string; updated_at: string }>(
      `SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision,item_type,updated_at
         FROM items WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`, [keys.userId],
    );
    return Promise.all(rows.rows.map(async row => {
      const item = JSON.parse(await decryptItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      return { id: row.id, type: item.type, name: item.name, username: item.username, uris: item.uris, revision: Number(row.revision), updatedAt: row.updated_at };
    }));
  }

  async revealHumanItem(sessionId: string | undefined, csrf: string | undefined, itemId: string): Promise<Record<string, unknown>> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const result = await this.db.query<ItemRow>(
      `SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision
         FROM items WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`, [itemId, keys.userId],
    );
    const row = result.rows[0];
    if (!row) throw new LocalVaultError('policy_denied', 404, 'Vault item was not found');
    const item = JSON.parse(await decryptItemText(
      { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
      { itemId: row.id, ownerId: keys.userId },
    )) as VaultItemPlaintext;
    return { id: row.id, revision: Number(row.revision), item };
  }

  async saveHumanItem(
    sessionId: string | undefined, csrf: string | undefined,
    input: { id?: string; revision?: number; item: VaultItemPlaintext },
  ): Promise<{ id: string; revision: number }> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    if (!input.item || typeof input.item.name !== 'string' || !input.item.name.trim() || !input.item.agentPolicy) {
      throw new LocalVaultError('invalid_operation', 400, 'Vault item is invalid');
    }
    const id = input.id ?? randomUUID();
    const encrypted = await encryptItem(JSON.stringify(input.item), keys.userKey, { itemId: id, ownerId: keys.userId });
    if (!input.id) {
      const created = await this.db.query<{ revision: number }>(
        `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING revision`,
        [id, keys.userId, input.item.type, encrypted.ciphertext, encrypted.encryptedItemKey, input.item.agentPolicy,
          input.item.integration ? `${ input.item.integration.integrationId }/${ input.item.integration.accountId }` : null],
      );
      return { id, revision: created.rows[0].revision };
    }
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new LocalVaultError('invalid_operation', 400, 'Item revision is required');
    const updated = await this.db.query<{ revision: number }>(
      `UPDATE items SET item_type=$1,ciphertext=$2,encrypted_item_key=$3,agent_policy=$4,integration_ref=$5,
              revision=revision+1,updated_at=now()
        WHERE id=$6 AND owner_user_id=$7 AND revision=$8 AND deleted_at IS NULL RETURNING revision`,
      [input.item.type, encrypted.ciphertext, encrypted.encryptedItemKey, input.item.agentPolicy,
        input.item.integration ? `${ input.item.integration.integrationId }/${ input.item.integration.accountId }` : null,
        id, keys.userId, revision],
    );
    if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; reload and retry');
    return { id, revision: updated.rows[0].revision };
  }

  async deleteHumanItem(sessionId: string | undefined, csrf: string | undefined, itemId: string, revision: number): Promise<void> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const result = await this.db.query(
      `UPDATE items SET deleted_at=now(),revision=revision+1,updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND revision=$3 AND deleted_at IS NULL RETURNING id`,
      [itemId, keys.userId, revision],
    );
    if (!result.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; reload and retry');
  }

  async changeHumanPassword(
    sessionId: string | undefined, csrf: string | undefined, currentPassword: string, nextPassword: string,
  ): Promise<{ cacheMode: 'helper-update-required' }> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (!currentPassword || !nextPassword) throw new LocalVaultError('invalid_credentials', 400, 'Current and new passwords are required');
    const keys = this.requireKeys();
    const account = await this.db.query<{
      login_hash_salt: Buffer; login_hash_verifier: Buffer;
      kdf: { password?: { salt: string; parameters: { memoryBytes: number; operations: number } } };
    }>('SELECT login_hash_salt,login_hash_verifier,kdf FROM users WHERE id=$1', [keys.userId]);
    const passwordKdf = account.rows[0]?.kdf?.password;
    if (!passwordKdf) throw new LocalVaultError('invalid_credentials', 409, 'Password unlock is not configured');
    const current = await deriveMasterKey(currentPassword, passwordKdf.salt, passwordKdf.parameters);
    const next = await deriveMasterKey(nextPassword);
    try {
      if (!verifyLoginHash(await deriveLoginHash(current.key), account.rows[0].login_hash_salt, account.rows[0].login_hash_verifier)) {
        throw new LocalVaultError('invalid_credentials', 401, 'Current password is invalid');
      }
      const verifier = makeLoginVerifier(await deriveLoginHash(next.key));
      const wrapped = await encryptWithKey(keys.userKey, next.key, 'sulla:user-key:v1');
      await this.db.query(
        `UPDATE users SET login_hash_salt=$1,login_hash_verifier=$2,encrypted_user_key=$3,kdf=$4,updated_at=now() WHERE id=$5`,
        [verifier.salt, verifier.verifier, wrapped,
          { authority: 'container', version: 1, password: { salt: next.salt, parameters: next.parameters } }, keys.userId],
      );
      this.stageCacheUpdate(next.key);
      return { cacheMode: 'helper-update-required' };
    } finally {
      current.key.fill(0);
      next.key.fill(0);
    }
  }

  async configureHumanRecovery(
    sessionId: string | undefined, csrf: string | undefined, recoveryCode: string,
  ): Promise<void> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (recoveryCode.length < 12) throw new LocalVaultError('invalid_credentials', 400, 'Recovery code is too short');
    const keys = this.requireKeys();
    const recovery = await deriveMasterKey(recoveryCode);
    try {
      const verifier = makeLoginVerifier(await deriveLoginHash(recovery.key));
      const wrapped = await encryptWithKey(keys.userKey, recovery.key, 'sulla:recovery-user-key:v1');
      await this.db.query(
        `INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT(user_id) DO UPDATE SET recovery_salt=$2,recovery_verifier=$3,encrypted_user_key=$4,updated_at=now()`,
        [keys.userId, JSON.stringify({ kdf: recovery.salt, verifier: verifier.salt.toString('base64url'), parameters: recovery.parameters }),
          verifier.verifier.toString('base64url'), wrapped],
      );
    } finally {
      recovery.key.fill(0);
    }
  }

  async recoverHumanSession(
    sessionId: string | undefined, csrf: string | undefined, recoveryCode: string, nextPassword: string,
  ): Promise<{ sessionId: string; csrf: string; expiresAt: number; phase: 'unlocked'; state: LocalVaultState; cacheMode: 'helper-update-required' }> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Recovery requires a locked vault');
    const attemptGeneration = this.generation;
    const result = await this.db.query<{
      user_id: string; recovery_salt: string; recovery_verifier: string; encrypted_user_key: EncryptedEnvelope;
    }>('SELECT user_id,recovery_salt,recovery_verifier,encrypted_user_key FROM local_vault_recovery LIMIT 1');
    if (!result.rowCount) throw new LocalVaultError('invalid_credentials', 404, 'Vault recovery is not configured');
    const row = result.rows[0];
    const metadata = JSON.parse(row.recovery_salt) as { kdf: string; verifier: string; parameters: { memoryBytes: number; operations: number } };
    const recovery = await deriveMasterKey(recoveryCode, metadata.kdf, metadata.parameters);
    const next = await deriveMasterKey(nextPassword);
    let recoveredUserKey: Uint8Array | undefined;
    try {
      if (!verifyLoginHash(await deriveLoginHash(recovery.key), Buffer.from(metadata.verifier, 'base64url'), Buffer.from(row.recovery_verifier, 'base64url'))) {
        throw new LocalVaultError('invalid_credentials', 401, 'Recovery code is invalid');
      }
      recoveredUserKey = await decryptWithKey(row.encrypted_user_key, recovery.key, 'sulla:recovery-user-key:v1');
      const verifier = makeLoginVerifier(await deriveLoginHash(next.key));
      const wrapped = await encryptWithKey(recoveredUserKey, next.key, 'sulla:user-key:v1');
      await this.db.query(
        `UPDATE users SET login_hash_salt=$1,login_hash_verifier=$2,encrypted_user_key=$3,kdf=$4,updated_at=now() WHERE id=$5`,
        [verifier.salt, verifier.verifier, wrapped,
          { authority: 'container', version: 1, password: { salt: next.salt, parameters: next.parameters } }, row.user_id],
      );
      const unlocked = await this.activateMasterKey(next.key, undefined,
        { authority: 'container', version: 1, password: { salt: next.salt, parameters: next.parameters } }, attemptGeneration);
      this.stageCacheUpdate(next.key);
      const rotated = this.issueHumanSession();
      if (rotated.phase !== 'unlocked') throw new LocalVaultError('vault_unavailable', 503, 'Recovery did not unlock the vault');
      return { ...rotated, phase: 'unlocked', state: unlocked.state, cacheMode: 'helper-update-required' };
    } finally {
      recovery.key.fill(0);
      next.key.fill(0);
      recoveredUserKey?.fill(0);
    }
  }

  async exportHumanBackup(
    sessionId: string | undefined, csrf: string | undefined, backupPassword: string,
  ): Promise<HumanBackupEnvelope> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (!backupPassword) throw new LocalVaultError('invalid_credentials', 400, 'Backup password is required');
    const keys = this.requireKeys();
    const [user, items, recovery] = await Promise.all([
      this.db.query('SELECT id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf FROM users WHERE id=$1', [keys.userId]),
      this.db.query('SELECT id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref,revision,created_at,updated_at FROM items WHERE owner_user_id=$1 AND deleted_at IS NULL', [keys.userId]),
      this.db.query('SELECT user_id,recovery_salt,recovery_verifier,encrypted_user_key FROM local_vault_recovery WHERE user_id=$1', [keys.userId]),
    ]);
    const backup = await deriveMasterKey(backupPassword);
    try {
      const payload = Buffer.from(JSON.stringify({ version: 1, user: user.rows[0], items: items.rows, recovery: recovery.rows[0] ?? null }));
      const envelope = await encryptWithKey(payload, backup.key, 'sulla:local-backup:v1');
      payload.fill(0);
      return { version: 1, salt: backup.salt, parameters: backup.parameters, envelope };
    } finally {
      backup.key.fill(0);
    }
  }

  async importHumanBackup(
    sessionId: string | undefined, csrf: string | undefined, backupPassword: string, backupEnvelope: HumanBackupEnvelope,
  ): Promise<void> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Backup import requires a locked vault');
    if (!backupPassword || backupEnvelope?.version !== 1) throw new LocalVaultError('invalid_operation', 400, 'Backup input is invalid');
    const existing = await this.db.query('SELECT 1 FROM users LIMIT 1');
    if (existing.rowCount) throw new LocalVaultError('policy_denied', 409, 'Backup import requires an empty local vault');
    const backup = await deriveMasterKey(backupPassword, backupEnvelope.salt, backupEnvelope.parameters);
    let clear: Uint8Array | undefined;
    try {
      clear = await decryptWithKey(backupEnvelope.envelope, backup.key, 'sulla:local-backup:v1');
      const payload = JSON.parse(Buffer.from(clear).toString('utf8')) as { version: number; user: any; items: any[]; recovery: any | null };
      if (payload.version !== 1 || !payload.user?.id || !Array.isArray(payload.items)) throw new Error('invalid backup payload');
      const asBuffer = (value: unknown): Buffer => {
        if (!value || typeof value !== 'object' || !Array.isArray((value as any).data)) throw new Error('invalid backup byte field');
        return Buffer.from((value as any).data);
      };
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [payload.user.id, payload.user.email, asBuffer(payload.user.login_hash_salt), asBuffer(payload.user.login_hash_verifier),
            payload.user.public_key, payload.user.encrypted_private_key, payload.user.encrypted_user_key, payload.user.kdf],
        );
        for (const item of payload.items) {
          await client.query(
            `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref,revision,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [item.id, payload.user.id, item.item_type, item.ciphertext, item.encrypted_item_key, item.agent_policy,
              item.integration_ref, item.revision, item.created_at, item.updated_at],
          );
        }
        if (payload.recovery) {
          await client.query(
            `INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key) VALUES ($1,$2,$3,$4)`,
            [payload.user.id, payload.recovery.recovery_salt, payload.recovery.recovery_verifier, payload.recovery.encrypted_user_key],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof LocalVaultError) throw error;
      throw new LocalVaultError('invalid_credentials', 400, 'Backup password or payload is invalid');
    } finally {
      backup.key.fill(0);
      clear?.fill(0);
    }
  }

  requireControlIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.controlServiceId || !constantEqual(token, this.config.controlServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Desktop control identity is invalid');
    }
  }

  brokerStatus(callerId: string, token: string | undefined): {
    state: LocalVaultState; unlocked: boolean; principalId?: string;
  } {
    this.requireBrokerIdentity(callerId, token);
    const { state, unlocked, principalId } = this.status();
    return { state, unlocked, principalId };
  }

  async integrationMetadata(
    callerId: string, token: string | undefined, integrationId: string, accountFilter?: string,
  ): Promise<import('./contracts.js').BrokerIntegrationMetadataResponse> {
    this.requireBrokerIdentity(callerId, token);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration identifier is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    const result = await this.db.query<ItemRow & { integration_ref: string }>(
      `SELECT id,owner_user_id,collection_id,ciphertext,encrypted_item_key,agent_policy,revision,integration_ref
         FROM items
        WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL
          AND split_part(integration_ref,'/',1)=$2
          AND ($3::text IS NULL OR split_part(integration_ref,'/',2)=$3)
        ORDER BY updated_at DESC`,
      [keys.userId, integrationId, accountFilter ?? null],
    );
    this.requireGeneration(generation);
    const active = await this.db.query<{ active_account_id: string | null }>(
      'SELECT active_account_id FROM local_integration_state WHERE owner_user_id=$1 AND integration_id=$2',
      [keys.userId, integrationId],
    );
    this.requireGeneration(generation);
    const availableIds = result.rows.map(item => item.integration_ref.slice(integrationId.length + 1));
    const configuredActive = active.rows[0]?.active_account_id;
    const activeAccountId = configuredActive && availableIds.includes(configuredActive)
      ? configuredActive
      : availableIds[0];
    const accounts = await Promise.all(result.rows.map(async item => {
      const plaintext = JSON.parse(await decryptItemText(
        { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
        keys.userKey,
        { itemId: item.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      this.requireGeneration(generation);
      const sourceProperties = plaintext.integration?.properties ?? {};
      const properties = safeIntegrationMetadata(sourceProperties);
      const accountId = item.integration_ref.slice(integrationId.length + 1);
      const explicitStatus = properties.connection_status?.toLowerCase();
      const hasCredential = Object.entries(sourceProperties)
        .some(([name, value]) => CREDENTIAL_PROPERTY_PATTERN.test(name) && typeof value === 'string' && value.length > 0);
      return {
        accountId,
        label: properties.account_label || accountId,
        connected: explicitStatus ? ['connected', 'true'].includes(explicitStatus) : hasCredential,
        active: accountId === activeAccountId,
        revision: item.revision,
        properties,
      };
    }));
    this.requireGeneration(generation);
    return { integrationId, activeAccountId, accounts };
  }

  async setActiveIntegrationAccount(
    callerId: string, token: string | undefined, integrationId: string, accountId: string,
  ): Promise<import('./contracts.js').BrokerIntegrationMetadataResponse> {
    this.requireBrokerIdentity(callerId, token);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account identifier is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    const exists = await this.db.query(
      `SELECT 1 FROM items WHERE owner_user_id=$1 AND integration_ref=$2 AND collection_id IS NULL AND deleted_at IS NULL`,
      [keys.userId, `${ integrationId }/${ accountId }`],
    );
    this.requireGeneration(generation);
    if (!exists.rowCount) throw new LocalVaultError('invalid_operation', 404, 'Integration account is unavailable');
    await this.db.query(
      `INSERT INTO local_integration_state(owner_user_id,integration_id,active_account_id)
       VALUES ($1,$2,$3)
       ON CONFLICT(owner_user_id,integration_id) DO UPDATE SET active_account_id=$3,updated_at=now()`,
      [keys.userId, integrationId, accountId],
    );
    this.requireGeneration(generation);
    return this.integrationMetadata(callerId, token, integrationId);
  }

  private requireBrokerIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.brokerServiceId || !constantEqual(token, this.config.brokerServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Broker service identity is invalid');
    }
  }

  async migrateLegacy(callerId: string, token: string | undefined): Promise<LegacyMigrationResponse> {
    this.requireControlIdentity(callerId, token);
    const keys = this.requireKeys();
    const generation = this.generation;
    if (!this.config.legacyDatabaseUrl) {
      this.migrationState = 'unlocked';
      return { batchId: 'not-required', imported: 0, skipped: 0, state: 'unlocked' };
    }

    const legacy = new Pool({ connectionString: this.config.legacyDatabaseUrl, max: 1 });
    let rows: LegacyIntegrationRow[] = [];
    try {
      const client = await legacy.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query<LegacyIntegrationRow>(
          `SELECT 'integration_value'::text AS source_kind,value_id,integration_id,account_id,property,value,is_default,created_at,updated_at
             FROM integration_values
           UNION ALL
           SELECT 'oauth_token', token_id * 10 + property_index, integration_id, account_id, property, value, false, created_at, updated_at
             FROM oauth_tokens
             CROSS JOIN LATERAL (VALUES
               (1,'access_token',access_token),
               (2,'refresh_token',refresh_token),
               (3,'token_type',token_type),
               (4,'scope',scope),
               (5,'expires_at',expires_at::text),
               (6,'provider_id',provider_id)
             ) AS oauth_properties(property_index,property,value)
            WHERE value IS NOT NULL
            ORDER BY source_kind,value_id`,
        );
        rows = result.rows;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch {
      this.migrationState = 'migration_failed';
      throw new LocalVaultError('migration_failed', 409, 'Legacy credential source could not be read');
    } finally {
      await legacy.end().catch(() => undefined);
    }

    const sourceFingerprint = stableLegacyFingerprint(rows);
    const already = await this.db.query<{ id: string; imported_count: number; skipped_count: number }>(
      "SELECT id,imported_count,skipped_count FROM local_vault_migration_batches WHERE source_fingerprint=$1 AND status='committed'",
      [sourceFingerprint],
    );
    if (already.rowCount) {
      this.requireGeneration(generation);
      this.migrationState = 'unlocked';
      return { batchId: already.rows[0].id, imported: 0, skipped: rows.length, state: 'unlocked' };
    }

    const groups = new Map<string, LegacyIntegrationRow[]>();
    for (const row of rows) {
      const key = `${ row.integration_id }\0${ row.account_id }`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const client = await this.db.connect();
    let batchId = '';
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-legacy-import'))");
      const batch = await client.query<{ id: string }>(
        `INSERT INTO local_vault_migration_batches(source_fingerprint,status)
         VALUES ($1,'running')
         ON CONFLICT(source_fingerprint) DO UPDATE SET status='running',error_code=NULL
         RETURNING id`, [sourceFingerprint],
      );
      batchId = batch.rows[0].id;
      let imported = 0;
      let skipped = 0;
      for (const groupRows of groups.values()) {
        this.requireGeneration(generation);
        const { integration_id: integrationId, account_id: accountId } = groupRows[0];
        const existing = await client.query(
          'SELECT id FROM items WHERE integration_ref=$1 AND owner_user_id=$2 AND deleted_at IS NULL',
          [`${ integrationId }/${ accountId }`, keys.userId],
        );
        if (existing.rowCount) {
          skipped += groupRows.length;
          continue;
        }
        const properties: Record<string, string> = {};
        for (const row of groupRows) properties[row.property] = decryptLegacyValue(row.value, keys.legacyVmk);
        const policy = agentPolicyFromLegacyLlmAccess(properties.llm_access);
        const sites = new Set(trustedOriginsForIntegration(integrationId));
        for (const property of ['base_url', 'server_url', 'gateway_url', 'url', 'endpoint']) {
          const raw = properties[property];
          if (!raw) continue;
          try {
            const url = new URL(raw);
            if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) sites.add(url.hostname.toLowerCase());
          } catch { /* An invalid legacy URL is not promoted into broker policy. */ }
        }
        policy.sites = [...sites];
        const itemId = randomUUID();
        const plaintext: VaultItemPlaintext = {
          type: 'apiKey',
          name: `${ integrationId } (${ accountId })`,
          integration: { integrationId, accountId, properties },
          agentPolicy: policy,
        };
        const encrypted = await encryptItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
        const reopened = await decryptItemText(encrypted, keys.userKey, { itemId, ownerId: keys.userId });
        if (reopened !== JSON.stringify(plaintext)) {
          throw new LocalVaultError('migration_failed', 409, 'Migrated item failed reopen verification');
        }
        await client.query(
          `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
           VALUES ($1,$2,'apiKey',$3,$4,$5,$6)`,
          [itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy, `${ integrationId }/${ accountId }`],
        );
        for (const row of groupRows) {
          await client.query(
            `INSERT INTO local_vault_migration_rows(source_kind,source_value_id,source_fingerprint,item_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT(source_kind,source_value_id) DO NOTHING`,
            [row.source_kind, row.value_id, sourceFingerprint, itemId],
          );
        }
        imported += groupRows.length;
      }
      this.requireGeneration(generation);
      await client.query(
        `UPDATE local_vault_migration_batches SET status='committed',imported_count=$2,skipped_count=$3,committed_at=now()
          WHERE id=$1`, [batchId, imported, skipped],
      );
      await client.query('COMMIT');
      keys.legacyVmk?.fill(0);
      keys.legacyVmk = undefined;
      this.migrationState = 'unlocked';
      return { batchId, imported, skipped, state: 'unlocked' };
    } catch (error) {
      await client.query('ROLLBACK');
      this.migrationState = 'migration_failed';
      if (batchId) {
        await this.db.query(
          `UPDATE local_vault_migration_batches SET status='failed',error_code='migration_failed' WHERE id=$1`, [batchId],
        ).catch(() => undefined);
      }
      if (error instanceof LocalVaultError) throw error;
      throw new LocalVaultError('migration_failed', 409, 'Legacy migration rolled back');
    } finally {
      client.release();
    }
  }

  approve(callerId: string, token: string | undefined, operationId: string): { approvalId: string; expiresAt: number } {
    if (callerId !== this.config.approvalServiceId || !constantEqual(token, this.config.approvalServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Approval service identity is invalid');
    }
    const pendingExpiry = this.pendingApprovals.get(operationId);
    this.pendingApprovals.delete(operationId);
    if (!pendingExpiry || pendingExpiry <= Date.now()) throw new LocalVaultError('approval_not_pending', 404, 'Approval request is not pending');
    const approvalId = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + APPROVAL_TTL_MS;
    this.approvals.set(approvalId, { digest: operationId, expiresAt });
    return { approvalId, expiresAt };
  }

  async execute(input: BrokerExecuteRequest, serviceId: string, token: string | undefined): Promise<BrokerExecuteResponse> {
    if (input.responseType === 'stream' || input.responseType === 'binary-stream') {
      throw new LocalVaultError('invalid_operation', 400, 'Use execute-stream for streaming operations');
    }
    if (['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke'].includes(input.operation)) {
      return this.executeOAuthMutation(input, serviceId, token);
    }
    const prepared = await this.prepareBrokerRequest(input, serviceId, token);
    const result = await this.send(
      prepared.target, input.method, prepared.headers, prepared.body,
      input.responseType ?? 'json', prepared.secrets, prepared.generation, true, prepared.maxRequestBytes,
    );
    if (prepared.item) await this.audit(input, prepared.item, false, null);
    return result;
  }

  async createRelay(
    input: BrokerRelayCreateRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<BrokerRelayCreateResponse> {
    this.requireBrokerIdentity(serviceId, token);
    const expected = input.operation === 'slack.socket-mode'
      ? { integrationId: 'slack', host: 'slack.com', fields: ['app_token', 'app_level_token'], gatewayField: undefined }
      : input.operation === 'discord.gateway'
        ? { integrationId: 'discord', host: 'discord.com', fields: ['bot_token', 'token'], gatewayField: undefined }
        : input.operation === 'enterprise.gateway'
          ? { integrationId: 'enterprise_gateway', host: null, fields: ['api_key'], gatewayField: 'gateway_url' }
          : null;
    if (!expected || input.ref.integrationId !== expected.integrationId) {
      throw new LocalVaultError('policy_denied', 403, 'Relay operation is not registered for this integration');
    }
    const request: BrokerExecuteRequest = {
      claims: input.claims,
      operation: input.operation,
      ref: input.ref,
      url: expected.host ? `https://${ expected.host }/vault-relay` : 'https://enterprise.invalid/vault-relay',
      method: 'POST',
      headers: {},
      body: null,
      injections: [],
      approvalId: input.approvalId,
      responseType: 'json',
    };
    const keys = this.requireKeys();
    const generation = this.generation;
    const item = await this.loadBrokerItem(request, expected.host);
    const plaintext = JSON.parse(await decryptItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    let gatewayUrl: string | undefined;
    let gatewayAddress: { address: string; family: 4 | 6 } | undefined;
    if (input.operation === 'enterprise.gateway') {
      const rawGatewayUrl = expected.gatewayField ? credentialField(plaintext, expected.gatewayField) : undefined;
      if (!rawGatewayUrl) throw new LocalVaultError('credential_field_missing', 404, 'Enterprise gateway URL is unavailable');
      try {
        const gateway = enterpriseGatewayOrigin(rawGatewayUrl);
        gatewayUrl = gateway.origin;
        const pinned = await this.validateTarget(gateway.origin);
        gatewayAddress = { address: pinned.pinnedAddress, family: pinned.pinnedFamily };
        request.url = `${ gateway.origin }/vault-relay`;
        const siteDecision = agentPolicyAllows(item.agent_policy ?? plaintext.agentPolicy, {
          agentId: input.claims.agent_id, level: 'autofill', host: gateway.hostname, onServer: false,
        });
        if (!siteDecision.allowed) throw new Error('policy_denied');
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'Enterprise gateway relay destination is denied');
      }
    }
    const digest = operationDigest(request);
    if ((item.agent_policy ?? plaintext.agentPolicy).askFirst) {
      const approval = input.approvalId ? this.approvals.get(input.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (input.approvalId) this.approvals.delete(input.approvalId);
        this.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.approvals.delete(input.approvalId!);
    }
    const credential = expected.fields.map(field => credentialField(plaintext, field)).find(Boolean);
    if (!credential) throw new LocalVaultError('credential_field_missing', 404, 'Relay credential is unavailable');
    const relayId = createRelayId();
    const controller = new AbortController();
    this.relaySessions.set(relayId, { generation, controller });
    try {
      const handle = await this.relayManager.open({
        relayId, operation: input.operation, credential, gatewayUrl, gatewayAddress, abortSignal: controller.signal,
      });
      this.requireGeneration(generation);
      await this.audit(request, item, false, null);
      return handle;
    } catch (error) {
      controller.abort(error);
      this.relaySessions.delete(relayId);
      this.relayManager.close(relayId, 'open_failed');
      throw error;
    }
  }

  relayEvents(relayId: string, serviceId: string, token: string | undefined, signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    this.requireBrokerIdentity(serviceId, token);
    this.requireRelay(relayId);
    return this.relayManager.events(relayId, signal);
  }

  async sendRelay(
    relayId: string,
    command: BrokerRelaySendRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<void> {
    this.requireBrokerIdentity(serviceId, token);
    this.requireRelay(relayId);
    await this.relayManager.send(relayId, command);
    this.requireRelay(relayId);
  }

  closeRelay(relayId: string, serviceId: string, token: string | undefined): void {
    this.requireBrokerIdentity(serviceId, token);
    const relay = this.relaySessions.get(relayId);
    if (!relay) return;
    relay.controller.abort(new Error('relay_closed'));
    this.relaySessions.delete(relayId);
    this.relayManager.close(relayId, 'caller_closed');
  }

  private async executeOAuthMutation(input: BrokerExecuteRequest, serviceId: string, token: string | undefined): Promise<BrokerExecuteResponse> {
    const queueKey = `${ input.ref.integrationId ?? '' }/${ input.ref.accountId ?? '' }`;
    const previous = this.oauthRefreshQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.oauthRefreshQueues.set(queueKey, queued);
    await previous;
    try {
      const prepared = await this.prepareBrokerRequest(input, serviceId, token);
      const result = await this.send(
        prepared.target, input.method, prepared.headers, prepared.body,
        input.responseType === 'text' ? 'text' : 'json', prepared.secrets, prepared.generation, false,
        prepared.maxRequestBytes,
      );
      if (result.status < 200 || result.status >= 300) {
        throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth upstream rejected the request');
      }
      if (input.operation === 'oauth.revoke') {
        await this.clearOAuthTokens(prepared);
        await this.audit(input, prepared.item!, false, null);
        return { ...result, body: { revoked: true } };
      }
      await this.storeOAuthTokens(prepared, result.body);
      await this.audit(input, prepared.item!, false, null);
      return { ...result, body: this.sanitizeOAuthResult(input.operation, result.body) };
    } finally {
      release();
      if (this.oauthRefreshQueues.get(queueKey) === queued) this.oauthRefreshQueues.delete(queueKey);
    }
  }

  async executeStream(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
    sink: BrokerStreamSink,
  ): Promise<void> {
    const streamInput = {
      ...input,
      responseType: input.responseType === 'binary-stream' ? 'binary-stream' as const : 'stream' as const,
    };
    const prepared = await this.prepareBrokerRequest(streamInput, serviceId, token);
    await this.sendStream(prepared, streamInput, sink);
    if (prepared.item) await this.audit(streamInput, prepared.item, false, null);
  }

  private async prepareBrokerRequest(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<PreparedBrokerRequest> {
    this.requireBrokerIdentity(serviceId, token);
    if (!input.claims?.sub || !input.claims.agent_id || !input.claims.pod_id) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is incomplete');
    }
    if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(input.operation)) {
      throw new LocalVaultError('invalid_operation', 400, 'Broker operation is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    if (input.claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const target = await this.validateTarget(input.url);
    let catalogDecision = null;
    if (['catalog.http', 'mcp.http'].includes(input.operation)) {
      try {
        catalogDecision = await validateCatalogRequest(this.db, input, target);
      } catch {
        throw new LocalVaultError('policy_denied', 403, 'Registered catalog policy denied the request');
      }
    }
    if (catalogDecision?.credentialFree) {
      const scope = input.claims.credential_scope;
      if (!scope || scope.integration_id !== input.ref.integrationId || scope.account_id !== input.ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Public request is outside the signed caller scope');
      }
      this.requireGeneration(generation);
      return {
        target,
        headers: { ...(input.headers ?? {}), 'accept-encoding': 'identity' },
        body: input.body,
        secrets: [],
        generation,
        maxRequestBytes: MAX_RESPONSE_BYTES,
      };
    }
    const item = await this.loadBrokerItem(input, input.operation.startsWith('oauth.') ? null : target.hostname);
    const plaintext = JSON.parse(await decryptItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.collection_id ?? item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    const itemPolicy = item.agent_policy ?? plaintext.agentPolicy;
    let effectivePolicy = itemPolicy;
    if (input.operation.startsWith('oauth.')) {
      try {
        await validateOAuthDestination(this.db, input, plaintext);
        effectivePolicy = { ...itemPolicy, sites: [target.hostname] };
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'OAuth destination is not registered for this provider');
      }
    }
    const decision = agentPolicyAllows(effectivePolicy, {
      agentId: input.claims.agent_id,
      level: 'autofill',
      host: target.hostname,
      onServer: false,
    });
    if (!decision.allowed) throw new LocalVaultError('policy_denied', 403, decision.reason ?? 'Credential policy denied the operation');
    if (input.operation === 'enterprise.gateway.http') {
      const gatewayUrl = plaintext.integration?.properties.gateway_url;
      try {
        validateEnterpriseGatewayHttp(input, gatewayUrl ?? '');
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'Enterprise gateway destination is not bound to this account');
      }
    }
    try {
      if (!catalogDecision) validateOperation(input, target.hostname, effectivePolicy);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'policy_denied';
      const code = reason === 'method_denied' ? 'method_denied' : reason === 'destination_denied' ? 'destination_denied' : 'policy_denied';
      throw new LocalVaultError(code, 403, 'Registered operation policy denied the request');
    }

    const digest = operationDigest(input);
    if ((item.agent_policy ?? plaintext.agentPolicy).askFirst) {
      const approval = input.approvalId ? this.approvals.get(input.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (input.approvalId) this.approvals.delete(input.approvalId);
        this.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.approvals.delete(input.approvalId!);
    }

    const secrets: string[] = [];
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    headers['accept-encoding'] = 'identity';
    let body: unknown = input.bodyEncoding === 'base64' && typeof input.body === 'string'
      ? Buffer.from(input.body, 'base64')
      : input.body;
    for (const injection of input.injections) {
      const value = credentialField(plaintext, injection.field);
      if (typeof value !== 'string') throw new LocalVaultError('credential_field_missing', 404, 'Requested credential field is unavailable');
      if (Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
      secrets.push(value);
      const basicClientId = injection.scheme === 'BasicClient' ? credentialField(plaintext, 'client_id') : undefined;
      if (injection.scheme === 'BasicClient' && typeof basicClientId !== 'string') {
        throw new LocalVaultError('credential_field_missing', 404, 'OAuth client identity is unavailable');
      }
      const injected = injection.scheme === 'GitHubBasic'
        ? `Basic ${ Buffer.from(`x-access-token:${ value }`).toString('base64') }`
        : injection.scheme === 'BasicClient'
          ? `Basic ${ Buffer.from(`${ basicClientId }:${ value }`).toString('base64') }`
        : injection.scheme && injection.scheme !== 'raw' ? `${ injection.scheme } ${ value }` : value;
      secrets.push(injected);
      if (injection.target === 'header') {
        if (!/^[A-Za-z0-9-]+$/.test(injection.name)) throw new LocalVaultError('invalid_injection', 400, 'Invalid header injection name');
        headers[injection.name] = injected;
      } else if (injection.target === 'query') {
        target.searchParams.set(injection.name, injected);
      } else if (injection.target === 'form') {
        const form = body instanceof URLSearchParams
          ? body
          : typeof body === 'string' ? new URLSearchParams(body)
            : new URLSearchParams(Object.entries(body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {})
              .filter(([, entry]) => ['string', 'number', 'boolean'].includes(typeof entry))
              .map(([name, entry]) => [name, String(entry)]));
        form.set(injection.name, injected);
        body = form;
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        body = applyJsonPath(body, injection.name, injected);
      }
    }
    if (input.operation === 'provider.transcription') {
      try {
        const transformed = buildTranscriptionProviderRequest(body, headers);
        body = transformed.body;
        for (const name of Object.keys(headers)) delete headers[name];
        Object.assign(headers, transformed.headers);
      } catch {
        throw new LocalVaultError('invalid_operation', 400, 'Transcription request is invalid');
      }
    }
    this.requireGeneration(generation);
    return {
      target,
      headers,
      body,
      secrets,
      generation,
      maxRequestBytes: input.operation === 'provider.transcription' ? MAX_TRANSCRIPTION_REQUEST_BYTES : MAX_RESPONSE_BYTES,
      item,
      plaintext,
    };
  }

  private bootstrapToken(): string {
    if (!this.config.bootstrapServiceToken || Buffer.byteLength(this.config.bootstrapServiceToken) < 32) {
      throw new LocalVaultError('vault_unavailable', 503, 'Bootstrap identity is not configured');
    }
    return this.config.bootstrapServiceToken;
  }

  private requireRelay(relayId: string): { generation: number; controller: AbortController } {
    const relay = this.relaySessions.get(relayId);
    if (!relay || relay.controller.signal.aborted) {
      throw new LocalVaultError('invalid_operation', 404, 'Relay session is unavailable');
    }
    this.requireGeneration(relay.generation);
    return relay;
  }

  private requireKeys(): UnlockedKeys {
    if (!this.keys) throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    return this.keys;
  }

  private requireGeneration(generation: number): void {
    if (!this.keys || generation !== this.generation) {
      throw new LocalVaultError('vault_locked', 423, 'Vault locked during request');
    }
  }

  private async validateTarget(raw: string): Promise<URL & { pinnedAddress: string; pinnedFamily: 4 | 6 }> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new LocalVaultError('invalid_destination', 400, 'Destination URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new LocalVaultError('invalid_destination', 403, 'Destination must be HTTPS without credentials or fragments');
    }
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(candidate => privateAddress(candidate.address))) {
      throw new LocalVaultError('destination_denied', 403, 'Destination resolved to a private, local, or invalid address');
    }
    return Object.assign(url, { pinnedAddress: addresses[0].address, pinnedFamily: addresses[0].family as 4 | 6 });
  }

  private async loadBrokerItem(input: BrokerExecuteRequest, host: string | null): Promise<ItemRow> {
    const ref = input.ref ?? {};
    const scope = input.claims.credential_scope;
    if (!scope || !ref.integrationId || !ref.accountId ||
        scope.integration_id !== ref.integrationId || scope.account_id !== ref.accountId) {
      throw new LocalVaultError('policy_denied', 403, 'Credential reference is outside the signed caller scope');
    }
    if (ref.itemId) throw new LocalVaultError('policy_denied', 403, 'Direct item references are not accepted by the local broker');
    if (input.operation === 'github.git') {
      const path = new URL(input.url).pathname;
      const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      const repository = match ? `${ match[1] }/${ match[2] }`.toLowerCase() : '';
      if (!scope.repository || repository !== scope.repository.replace(/\.git$/i, '').toLowerCase()) {
        throw new LocalVaultError('policy_denied', 403, 'Git repository is outside the signed caller scope');
      }
    }
    const integrationRef = ref.integrationId ? `${ ref.integrationId }/${ ref.accountId ?? 'default' }` : null;
    const result = await this.db.query<ItemRow>(
      `SELECT i.id,i.owner_user_id,i.collection_id,i.ciphertext,i.encrypted_item_key,i.agent_policy,i.revision,
              c.org_id,om.role,cm.can_use_by_agents,
              EXISTS (SELECT 1 FROM group_members gm JOIN collection_group_members cgm ON cgm.group_id=gm.group_id
                WHERE gm.user_id=$1 AND cgm.collection_id=i.collection_id AND cgm.can_use_by_agents=true) AS group_can_use_by_agents
         FROM items i LEFT JOIN collections c ON c.id=i.collection_id
         LEFT JOIN org_members om ON om.org_id=c.org_id AND om.user_id=$1 AND om.status='confirmed'
         LEFT JOIN collection_members cm ON cm.collection_id=i.collection_id AND cm.user_id=$1
        WHERE i.deleted_at IS NULL AND (($2::uuid IS NOT NULL AND i.id=$2) OR ($3::text IS NOT NULL AND i.integration_ref=$3)) LIMIT 1`,
      [input.claims.sub, ref.itemId ?? null, integrationRef],
    );
    const item = result.rows[0];
    const personal = item?.owner_user_id === input.claims.sub;
    // Local authority has only the personal user key in memory. It must never
    // attempt to decrypt a collection item with that key; collection-key
    // custody remains a separate server-mode path until explicitly supported.
    if (!item || !personal || item.collection_id) {
      if (item) await this.audit(input, item, true, 'User cannot use this credential');
      throw new LocalVaultError('policy_denied', 403, 'Credential is unavailable to this caller');
    }
    if (host) {
      const siteDecision = agentPolicyAllows(item.agent_policy, { agentId: input.claims.agent_id, level: 'autofill', host, onServer: false });
      if (!siteDecision.allowed) {
        await this.audit(input, item, true, siteDecision.reason ?? 'Credential policy denied the destination');
        throw new LocalVaultError('policy_denied', 403, siteDecision.reason ?? 'Credential policy denied the destination');
      }
    }
    return item;
  }

  private async sendStream(
    prepared: PreparedBrokerRequest,
    input: BrokerExecuteRequest,
    sink: BrokerStreamSink,
  ): Promise<void> {
    const method = input.method.toUpperCase();
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
    const headers = Object.fromEntries(Object.entries(prepared.headers).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    let payload: Buffer | undefined;
    if (prepared.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = serializeBrokerBody(prepared.body);
      if (payload.byteLength > MAX_STREAM_BYTES) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
    }
    const binary = input.responseType === 'binary-stream';
    const redactor = binary ? null : new StreamingRedactor(prepared.secrets);

    await new Promise<void>((resolve, reject) => {
      let started = false;
      let received = 0;
      this.requireGeneration(prepared.generation);
      const request = https.request({
        protocol: 'https:',
        hostname: prepared.target.hostname,
        servername: prepared.target.hostname,
        port: prepared.target.port ? Number(prepared.target.port) : 443,
        path: `${ prepared.target.pathname }${ prepared.target.search }`,
        method,
        headers,
        timeout: 120_000,
        lookup: pinnedLookup(prepared.target.pinnedAddress, prepared.target.pinnedFamily),
      }, response => {
        if (prepared.generation !== this.generation) {
          response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
          return;
        }
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          request.destroy(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
          return;
        }
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
        const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (contentEncoding && contentEncoding !== 'identity') {
          response.resume();
          request.destroy(new LocalVaultError('invalid_upstream_response', 502, 'Compressed broker streams are not accepted'));
          return;
        }
        const bodyless = streamResponseIsBodyless(method, response.statusCode ?? 0, response.headers['content-length']);
        if (!binary && !bodyless && !contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('event-stream') && !contentType.includes('ndjson')) {
          response.resume();
          request.destroy(new LocalVaultError('invalid_upstream_response', 502, 'Streaming adapter requires a textual upstream response'));
          return;
        }
        const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key|content-length)$/i;
        const outputHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = redact(value, prepared.secrets);
        }
        if (binary && typeof response.headers['content-length'] === 'string') outputHeaders['content-length'] = response.headers['content-length'];
        started = true;
        sink.start(response.statusCode ?? 502, outputHeaders);
        response.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > MAX_STREAM_BYTES) {
            request.destroy(new LocalVaultError('response_too_large', 502, 'Broker stream exceeded the size limit'));
            return;
          }
          const output = redactor ? redactor.transform(chunk) : chunk;
          if (output.byteLength && !sink.write(output)) {
            response.pause();
            sink.onceDrain(() => response.resume());
          }
        });
        response.on('end', () => {
          try { this.requireGeneration(prepared.generation); } catch (error) { request.destroy(error as Error); return; }
          const tail = redactor?.flush();
          if (tail?.byteLength) sink.write(tail);
          this.inFlight.delete(request);
          sink.end();
          resolve();
        });
        response.on('error', error => request.destroy(error));
      });
      this.inFlight.add(request);
      sink.onAbort(() => request.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected')));
      request.on('timeout', () => request.destroy(new LocalVaultError('upstream_timeout', 504, 'Broker stream timed out')));
      request.on('error', error => {
        this.inFlight.delete(request);
        const safe = error instanceof LocalVaultError ? error : new LocalVaultError('upstream_failed', 502, 'Broker upstream stream failed');
        if (started) {
          sink.destroy(safe);
          resolve();
        } else {
          reject(safe);
        }
      });
      if (payload) request.write(payload);
      request.end();
    });
  }

  private async send(
    url: URL & { pinnedAddress: string; pinnedFamily: 4 | 6 },
    methodInput: string,
    headersInput: Record<string, string>,
    bodyInput: unknown,
    responseType: 'json' | 'text',
    secrets: string[],
    generation: number,
    redactResponseBody = true,
    maxRequestBytes = MAX_RESPONSE_BYTES,
  ): Promise<BrokerExecuteResponse> {
    const method = methodInput.toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new LocalVaultError('method_denied', 403, 'HTTP method is not allowed');
    }
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
    const headers = Object.fromEntries(Object.entries(headersInput).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    let payload: Buffer | undefined;
    if (bodyInput !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = serializeBrokerBody(bodyInput);
      if (payload.byteLength > maxRequestBytes) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
      headers['content-type'] ??= Buffer.isBuffer(bodyInput)
        ? 'application/octet-stream'
        : bodyInput instanceof URLSearchParams ? 'application/x-www-form-urlencoded'
          : typeof bodyInput === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
    }

    return new Promise<BrokerExecuteResponse>((resolve, reject) => {
      this.requireGeneration(generation);
      const request = https.request({
        protocol: 'https:',
        hostname: url.hostname,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${ url.pathname }${ url.search }`,
        method,
        headers,
        timeout: 30_000,
        lookup: pinnedLookup(url.pinnedAddress, url.pinnedFamily),
      }, response => {
        if (generation !== this.generation) {
          response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
          return;
        }
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
          return;
        }
        const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (contentEncoding && contentEncoding !== 'identity') {
          response.resume();
          request.destroy(new LocalVaultError('invalid_upstream_response', 502, 'Compressed broker responses are not accepted'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) request.destroy(new LocalVaultError('response_too_large', 502, 'Broker response exceeded the size limit'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try { this.requireGeneration(generation); } catch (error) { reject(error); return; }
          const upstream = Buffer.concat(chunks).toString('utf8');
          const raw = redactResponseBody ? redact(upstream, secrets) : upstream;
          const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key)$/i;
          const outputHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = redact(value, secrets);
          }
          let body: unknown = raw;
          if (responseType === 'json' && raw) {
            try { body = JSON.parse(raw); } catch { reject(new LocalVaultError('invalid_upstream_response', 502, 'Expected a JSON response')); return; }
          }
          this.inFlight.delete(request);
          resolve({ status: response.statusCode ?? 502, headers: outputHeaders, body });
        });
      });
      this.inFlight.add(request);
      request.on('timeout', () => request.destroy(new LocalVaultError('upstream_timeout', 504, 'Broker request timed out')));
      request.on('error', error => {
        this.inFlight.delete(request);
        reject(error instanceof LocalVaultError ? error : new LocalVaultError('upstream_failed', 502, 'Broker upstream request failed'));
      });
      if (payload) request.write(payload);
      request.end();
    });
  }

  private async storeOAuthTokens(prepared: PreparedBrokerRequest, body: unknown): Promise<void> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth token response is invalid');
    }
    const response = body as Record<string, unknown>;
    if (typeof response.access_token !== 'string' || !response.access_token) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth response did not contain an access token');
    }
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const integration = prepared.plaintext.integration;
    if (!integration) throw new LocalVaultError('migration_failed', 409, 'OAuth item is missing its integration reference');
    integration.properties.access_token = response.access_token;
    if (typeof response.refresh_token === 'string' && response.refresh_token) integration.properties.refresh_token = response.refresh_token;
    if (typeof response.expires_in === 'number') integration.properties.expires_in = String(response.expires_in);
    if (typeof response.expires_in === 'number') integration.properties.expires_at = String(Date.now() + Math.max(0, response.expires_in) * 1000);
    if (typeof response.scope === 'string') integration.properties.scope = response.scope;
    if (typeof response.token_type === 'string') integration.properties.token_type = response.token_type;
    if (typeof response.id_token === 'string' && response.id_token) integration.properties.id_token = response.id_token;
    await this.persistOAuthItem(prepared, keys);
  }

  private async clearOAuthTokens(prepared: PreparedBrokerRequest): Promise<void> {
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    for (const field of ['access_token', 'refresh_token', 'id_token', 'expires_in', 'expires_at', 'scope', 'token_type']) {
      delete prepared.plaintext.integration.properties[field];
    }
    await this.persistOAuthItem(prepared, keys);
  }

  private async persistOAuthItem(prepared: PreparedBrokerRequest, keys: UnlockedKeys): Promise<void> {
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const ownerId = prepared.item.collection_id ?? prepared.item.owner_user_id ?? keys.userId;
    const encrypted = await encryptItem(JSON.stringify(prepared.plaintext), keys.userKey, {
      itemId: prepared.item.id,
      ownerId,
    });
    this.requireGeneration(prepared.generation);
    const updated = await this.db.query(
      `UPDATE items SET ciphertext=$1,encrypted_item_key=$2,agent_wrapped_item_key=NULL,
              revision=revision+1,updated_at=now()
        WHERE id=$3 AND revision=$4 AND deleted_at IS NULL RETURNING revision`,
      [encrypted.ciphertext, encrypted.encryptedItemKey, prepared.item.id, prepared.item.revision],
    );
    if (!updated.rowCount) throw new LocalVaultError('migration_failed', 409, 'OAuth item changed during token update');
  }

  private sanitizeOAuthResult(operation: string, body: unknown): Record<string, unknown> {
    const response = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    return {
      updated:    true,
      operation,
      expires_in: typeof response.expires_in === 'number' ? response.expires_in : undefined,
      expires_at: typeof response.expires_in === 'number' ? Date.now() + Math.max(0, response.expires_in) * 1000 : undefined,
      scope:      typeof response.scope === 'string' ? response.scope : undefined,
      token_type: typeof response.token_type === 'string' ? response.token_type : undefined,
    };
  }

  private stageCacheUpdate(masterKey: Uint8Array): void {
    this.stagedCacheUpdate?.masterKey.fill(0);
    this.cacheChallenges.clear();
    this.stagedCacheUpdate = {
      masterKey: Buffer.from(masterKey),
      expiresAt: Date.now() + CACHE_UPDATE_TTL_MS,
      generation: this.generation,
    };
  }

  private expireStagedCacheUpdate(): void {
    if (this.stagedCacheUpdate &&
        (this.stagedCacheUpdate.expiresAt <= Date.now() || this.stagedCacheUpdate.generation !== this.generation)) {
      this.stagedCacheUpdate.masterKey.fill(0);
      this.stagedCacheUpdate = null;
      this.cacheChallenges.clear();
    }
  }

  private async audit(input: BrokerExecuteRequest, item: ItemRow, blocked: boolean, reason: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_log(actor_user_id,org_id,collection_id,item_id,action,pod_id,metadata,blocked,reason)
       VALUES ($1,$2,$3,$4,'vault_outbound_request',$5,$6,$7,$8)`,
      [input.claims.sub, item.org_id ?? null, item.collection_id, item.id, input.claims.pod_id,
        { agentId: input.claims.agent_id, operation: input.operation, destination: new URL(input.url).origin }, blocked, reason],
    );
  }
}

