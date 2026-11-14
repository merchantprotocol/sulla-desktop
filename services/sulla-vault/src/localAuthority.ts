// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';

import pg from 'pg';
import { IdentityError, VaultOperationError, type LocalEncryptedItem, type LocalItemContext } from '@sulla/domain';

import {
  agentPolicyAllows,
  agentPolicyFromLegacyLlmAccess,
  deriveLoginHash,
  type AgentAccessLevel,
  type AgentPolicy,
  type EncryptedEnvelope,
  isKnownCustomFieldType,
  validateCustomFields,
  validateVaultItemProxy,
  type VaultItemCustomField,
  type VaultItemPlaintext,
} from '@sulla/vault-crypto';

import { makeLoginVerifier } from './auth.js';
import { BitwardenExportImporter, type BitwardenExportUpload, type BitwardenImportPreview } from './bitwarden/BitwardenExportImporter.js';
import { validateCatalogRequest } from './catalogPolicy.js';
import { enterpriseGatewayOrigin, validateEnterpriseGatewayHttp } from './gatewayPolicy.js';
import { brokerTransferLimits, FILES_SYNC_OPERATION, isTrustedFilesCloudCall, trustedOriginsForIntegration, validateItemHttpOperation, validateOperation } from './operationPolicy.js';
import { isNativeOAuthIntegration, validateOAuthDestination } from './oauthPolicy.js';
import { pinnedAddressesLookup, pinnedLookup, type PinnedAddress } from './pinnedLookup.js';
import {
  describeUpstreamError, familySummary, formatUpstreamFailureLog, isReconnectableUpstreamError, retryAddressOrder,
  UPSTREAM_CONNECT_TIMEOUT_MS, UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS, UPSTREAM_MAX_ATTEMPTS,
  UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS, UPSTREAM_RETRY_DELAYS_MS,
  upstreamFailurePhase, upstreamFailureReason,
} from './upstreamEgress.js';
import { createRelayId, DefaultVaultRelayManager } from './relays.js';
import { SULLA_CLOUD_HOST, SULLA_CLOUD_INTEGRATION_ID, sullaCloudRelayUrl, validateSullaCloudRelayParams } from './sullaCloudRelay.js';
import { buildTranscriptionProviderRequest } from './transcriptionPolicy.js';

import type { VaultConfig } from './config.js';
import type { FilesAuthorityIdentityLease, UnlockedFilesAuthorityIdentity } from './filesKeyBundleAuthority.js';
import type {
  BrokerCredentialRef,
  BrokerItemListResponse,
  BrokerOAuthAccountRequest,
  BrokerClaims,
  BrokerVaultItemWriteRequest,
  BrokerVaultItemUpdateRequest,
  BrokerVaultItemWriteResponse,
  BrokerIntegrationAccountImportRequest,
  BrokerIntegrationCredentialWriteRequest,
  BrokerExecuteRequest,
  BrokerExecuteResponse,
  BrokerRelayCreateRequest,
  BrokerRelayCreateResponse,
  BrokerRelaySendRequest,
  BrowserFillTarget,
  HumanBackupEnvelope,
  LegacyMigrationResponse,
  LocalVaultState,
  SullaCloudSessionAdoptRequest,
  SullaCloudDesktopRequest,
  SullaCloudSessionResponse,
  AccountPasswordRewrapRequest,
  AccountPasswordRewrapResponse,
  VaultDeviceApprovalWrapRequest,
  VaultEnrollmentWrapRequest, VaultEnrollmentAdoptRequest,
} from './contracts.js';
import { transportWrap } from './filesCloudEscrow.js';
import { FilesTransportEnvelopeService, type FilesTransportEnvelope as TransportEnvelope } from '@sulla/vault-crypto';
import { type SyncBundle, type SyncHead } from './browserEnvelope/envelope.js';
import { DomainVaultSyncCodecProvider } from './browserEnvelope/DomainVaultSyncCodecProvider.js';
import { StoredKeyEnvelopeReaderProvider } from './browserEnvelope/StoredKeyEnvelopeReaderProvider.js';
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
import type { Database, Queryable } from './db.js';
import { PostgresRewrapHistoryRepository } from './repositories/PostgresRewrapHistoryRepository.js';
import { PostgresSullaCloudRevocationRepository } from './repositories/PostgresSullaCloudRevocationRepository.js';
import { AgentMailboxCloudLane } from './sullaCloudSession/AgentMailboxCloudLane.js';
import { SullaCloudSessionManager } from './sullaCloudSession/SullaCloudSessionManager.js';
import { SullaCloudSessionManagerFactory } from './sullaCloudSession/SullaCloudSessionManagerFactory.js';
import { PostgresVaultAuditLogRepository, PostgresVaultItemRepository } from './repositories/PostgresVaultItemRepositories.js';
import { PostgresIntegrationStateRepository, PostgresLegacyCredentialRepository, PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository } from './repositories/PostgresVaultAuthorityRepositories.js';
import { FilesAuditEmitter } from './filesAudit.js';
import { BrokerRedirectPolicy } from './brokerRedirectPolicy.js';
import { DesktopHumanBackup } from './localCrypto/DesktopHumanBackup.js';
import type { VaultUserBackupRow } from './localCrypto/DesktopHumanBackup.js';
import { LocalVaultCryptoProvider } from './localCrypto/LocalVaultCryptoProvider.js';

const CHALLENGE_TTL_MS = 30_000;
const CACHE_UPDATE_TTL_MS = 60_000;
const CHALLENGE_RATE_WINDOW_MS = 60_000;
const CHALLENGE_RATE_LIMIT = 10;
const APPROVAL_TTL_MS = 2 * 60_000;
const HUMAN_SESSION_TTL_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_FILES_SYNC_UPLOAD_BYTES = 6 * 1024 * 1024;
const MAX_STREAM_BYTES = 25 * 1024 * 1024;
// Git pack transfers for a full fetch routinely exceed the API stream cap.
const MAX_GIT_STREAM_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const LEGACY_PREFIX = '$VAULT$';
const SAFE_INTEGRATION_METADATA_FIELDS = new Set([
  'account_label', 'connection_status', 'connected_at', 'last_sync_at', 'base_url', 'server_url',
  'gateway_url', 'resource_url', 'project_id', 'provider', 'provider_id', 'model', 'workspace_id', 'region', 'plan', 'llm_access', 'client_id', 'oauth_client_id',
  'expires_at', 'token_type', 'scope',
]);
const CREDENTIAL_PROPERTY_PATTERN = /(?:^|_)(?:token|key|secret|password|credential)$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROKER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';
const CHATGPT_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function extractBoundedChatgptAccountId(...tokens: unknown[]): string | undefined {
  for (const token of tokens) {
    if (typeof token !== 'string' || token.length > MAX_CREDENTIAL_BYTES) continue;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) continue;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const auth = (payload as Record<string, unknown>)[CHATGPT_AUTH_CLAIM];
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) continue;
      const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === 'string' && accountId.trim() === accountId && CHATGPT_ACCOUNT_ID_PATTERN.test(accountId)) {
        return accountId;
      }
    } catch { /* malformed tokens do not produce routing metadata */ }
  }
  return undefined;
}

function safeIntegrationMetadata(
  source: Record<string, unknown>,
  integrationId = '',
): Record<string, string> {
  const secrets = Object.entries(source)
    .filter(([name, value]) => CREDENTIAL_PROPERTY_PATTERN.test(name) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value as string);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!SAFE_INTEGRATION_METADATA_FIELDS.has(name) || typeof value !== 'string') continue;
    if (name === 'base_url' || name === 'server_url' || name === 'gateway_url' || name === 'resource_url') {
      try {
        const parsed = new URL(value);
        if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(name === 'base_url' && ['ollama', 'lm-studio', 'local-server'].includes(integrationId) && parsed.protocol === 'http:'))) continue;
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

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find(entry => entry.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** Sets content-type once, dropping any differently-cased copy the caller sent. */
function setContentType(headers: Record<string, string>, value: string): void {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
  headers['content-type'] = value;
}

function formFromObject(body: unknown): URLSearchParams {
  return new URLSearchParams(Object.entries(body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {})
    .filter(([, entry]) => ['string', 'number', 'boolean'].includes(typeof entry))
    .map(([name, entry]) => [name, String(entry)]));
}

export class LocalVaultError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    /** Non-secret diagnostic reason (e.g. `connect_ECONNREFUSED`) surfaced to broker callers. */
    public readonly reason?: string,
  ) {
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
  browserTarget?: BrowserFillTarget;
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
  target:     URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] };
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

function allowsByoUsageCloudRequest(method: string, path: string): boolean {
  return method === 'POST' && path === '/usage/byo-events';
}

const SULLA_CLOUD_DESKTOP_RULES: Array<[RegExp, readonly string[]]> = [
  [/^\/devices\/(?:register|heartbeat)$/, ['POST']],
  [/^\/desktop-channel\/tickets$/, ['POST']],
  [/^\/desktop-sync\/[A-Za-z0-9._~-]{1,200}\/(?:vault|conversations)$/, ['PUT', 'DELETE']],
  [/^\/cloud-runtime\/v1\/device\/(?:workflows|agents|skills|custom-agents|recipes|usage|memory|model-catalog)$/, ['PUT', 'DELETE']],
  [/^\/cloud-runtime\/v1\/device\/use-cases$/, ['DELETE']],
  [/^\/cloud-runtime\/v1\/device$/, ['DELETE']],
  [/^\/cloud-chat-links$/, ['GET', 'POST']],
  [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}$/, ['DELETE']],
  [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/deltas$/, ['POST']],
  [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/attachments\/[A-Za-z0-9._:~-]{1,200}$/, ['GET']],
  [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/cloud-results$/, ['GET']],
  [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/cloud-results\/[A-Za-z0-9_-]{1,200}\/ack$/, ['POST']],
  [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/replies\/[A-Za-z0-9_-]{1,200}\/(?:fail|complete)$/, ['POST']],
  [/^\/cloud-usecase-installs\/v1\/device-installs\/pending$/, ['GET']],
  [/^\/cloud-usecase-installs\/v1\/device-installs\/[0-9a-f-]{36}\/report$/, ['POST']],
  [/^\/cloud-vault-sync\/status$/, ['GET']],
  [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}$/, ['PUT', 'DELETE']],
  [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/bundle$/, ['GET']],
  [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/records$/, ['GET']],
  [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/(?:commit|pause|resume)$/, ['POST']],
  [/^\/cloud-vault-sync\/enrollment\/state$/, ['GET']],
  [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/enrollment\/requests$/, ['GET', 'POST']],
  [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/enrollment\/requests\/[0-9a-f-]{36}\/(?:respond|consume|confirm)$/, ['POST']],
  [/^\/auth\/password\/device-approval\/requests$/, ['GET']],
  [/^\/auth\/password\/device-approval\/requests\/[0-9a-f-]{36}\/respond$/, ['POST']],
  [/^\/files-sync\/v1\/collections$/, ['GET']],
  [/^\/files-sync\/v1\/usage$/, ['GET']],
  [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}$/, ['PUT', 'DELETE']],
  [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/(?:changes|keys)$/, ['GET']],
  [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/keys\/[1-9][0-9]*$/, ['PUT']],
  [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/chunks\/[0-9a-f]{64}$/, ['GET']],
  [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/uploads$/, ['POST']],
  [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/commit$/, ['POST']],
  [/^\/files-sync\/v1\/uploads\/[0-9a-f-]{36}$/, ['GET']],
  [/^\/files-sync\/v1\/uploads\/[0-9a-f-]{36}\/chunks\/[0-9a-f]{64}$/, ['PUT']],
  // Support Center (user side): tickets, feedback, uploads, consent, timeline.
  // Remote support (supporter side): Workers enforces super-admin + accepted-by-caller on each route.
  [/^\/super-admin\/support\/sessions$/, ['GET']],
  [/^\/super-admin\/support\/sessions\/[A-Za-z0-9_-]{1,200}\/(?:events|presence)$/, ['GET']],
  [/^\/super-admin\/support\/sessions\/[A-Za-z0-9_-]{1,200}\/(?:rpc|end|extend)$/, ['POST']],
  // Files catalog and just-in-time content stay scoped to the registered Desktop.
  [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}$/, ['PUT']],
  [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests$/, ['GET']],
  [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests\/[A-Za-z0-9._~-]{1,200}\/content$/, ['PUT']],
  [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests\/[A-Za-z0-9._~-]{1,200}\/(?:link|fail)$/, ['POST']],
  [/^\/shares$/, ['POST']],
  [/^\/shares\/[A-Za-z0-9._~-]{1,200}$/, ['PATCH', 'DELETE']],
  [/^\/shares\/[A-Za-z0-9._~-]{1,200}\/content$/, ['PUT']],
  [/^\/sync\/(?:push|pull)$/, ['GET', 'POST']],
  [/^\/marketplace\/(?:browse|topics|mine)$/, ['GET']],
  [/^\/marketplace\/submit-manifest$/, ['POST']],
  [/^\/marketplace\/templates\/[A-Za-z0-9._~-]{1,200}$/, ['GET', 'DELETE']],
  [/^\/marketplace\/templates\/[A-Za-z0-9._~-]{1,200}\/bundle$/, ['PUT']],
];
function allowsSullaCloudDesktopRequest(method: string, path: string): boolean {
  return allowsByoUsageCloudRequest(method, path) ||
    SULLA_CLOUD_DESKTOP_RULES.some(([pattern, methods]) => pattern.test(path) && methods.includes(method));
}

export const localAuthorityTestHooks = {
  allowsByoUsageCloudRequest,
  allowsSullaCloudDesktopRequest,
  credentialField,
  operationDigest,
  privateAddress,
  streamResponseIsBodyless,
  deriveChatgptAccountRoutingForRequest,
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
    item.fields?.find(candidate => candidate.name === field)?.value ??
    // Custom fields are usable by label at the same autofill level as the password; lowest priority.
    item.customFields?.find(candidate => candidate.label === field && typeof candidate.value === 'string')?.value;
}

function proxySource(item: VaultItemPlaintext, source: string): string | undefined {
  if (source === 'password') return item.password;
  if (source === 'username') return item.username;
  if (!source.startsWith('custom:')) return undefined;
  const name = source.slice(7);
  return item.fields?.find(candidate => candidate.name === name)?.value ??
    item.customFields?.find(candidate => candidate.label === name)?.value;
}

function proxyHostMatches(host: string, allowed: string): boolean {
  const normalized = allowed.toLowerCase().replace(/^\*\./, '');
  return host === normalized || (allowed.startsWith('*.') && host.endsWith(`.${ normalized }`));
}

function deriveChatgptAccountRoutingForRequest(
  input: Pick<BrokerExecuteRequest, 'operation' | 'ref'>,
  plaintext: VaultItemPlaintext,
): void {
  if (input.operation !== 'provider.cli' || input.ref.integrationId !== 'codex') return;
  const properties = plaintext.integration?.properties;
  if (!properties || properties.chatgpt_account_id) return;
  const accountId = extractBoundedChatgptAccountId(properties.id_token, properties.access_token);
  if (accountId) properties.chatgpt_account_id = accountId;
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

export class LocalVaultAuthority implements FilesAuthorityIdentityLease {
  private readonly filesTransport = new FilesTransportEnvelopeService();
  private keys: UnlockedKeys | null = null;
  private generation = 0;
  private readonly inFlight = new Set<ReturnType<typeof https.request>>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly cacheChallenges = new Map<string, Challenge>();
  private readonly challengeRate = new Map<string, { count: number; resetAt: number }>();
  private readonly pendingApprovals = new Map<string, number>();
  private readonly pendingVaultEnrollments = new Map<string,{expiresAt:number;bundle:SyncBundle;head:SyncHead;userKey:Uint8Array;privateKey:Uint8Array;masterKey:Uint8Array;cloudUserId:string}>();
  private readonly approvals = new Map<string, { digest: string; expiresAt: number }>();
  private readonly humanSessions = new Map<string, HumanSession>();
  private readonly oauthRefreshQueues = new Map<string, Promise<void>>();
  private sullaCloudSessionManager: SullaCloudSessionManager | null = null;
  private agentMailboxCloudLane: AgentMailboxCloudLane | null = null;
  private readonly relaySessions = new Map<string, { generation: number; controller: AbortController }>();
  private securityOperationTail: Promise<void> = Promise.resolve();
  private migrationState: LocalVaultState = 'locked';
  private stagedCacheUpdate: StagedCacheUpdate | null = null;
  private readonly filesAudit: FilesAuditEmitter;
  private codecProvider = new DomainVaultSyncCodecProvider();

  private readonly brokerRedirectPolicy = new BrokerRedirectPolicy();

  constructor(
    private readonly db: Database,
    private readonly config: VaultConfig,
    private readonly relayManager: VaultRelayManager = new DefaultVaultRelayManager(),
    private readonly rewrapHistory: PostgresRewrapHistoryRepository = new PostgresRewrapHistoryRepository(db),
    private readonly itemRepository: PostgresVaultItemRepository = new PostgresVaultItemRepository(db),
    private readonly auditLogRepository: PostgresVaultAuditLogRepository = new PostgresVaultAuditLogRepository(db),
    private readonly userRepository: PostgresVaultUserRepository = new PostgresVaultUserRepository(db),
    private readonly recoveryRepository: PostgresVaultRecoveryRepository = new PostgresVaultRecoveryRepository(db),
    private readonly integrationStateRepository: PostgresIntegrationStateRepository = new PostgresIntegrationStateRepository(db),
    private readonly migrationRepository: PostgresVaultMigrationRepository = new PostgresVaultMigrationRepository(db),
    private readonly syncStateRepository: PostgresVaultSyncStateRepository = new PostgresVaultSyncStateRepository(db),
    private readonly legacyCredentialRepository: PostgresLegacyCredentialRepository = new PostgresLegacyCredentialRepository(),
    private readonly keyEnvelopeReaderProvider: StoredKeyEnvelopeReaderProvider = new StoredKeyEnvelopeReaderProvider(),
    private readonly revocationRepository: PostgresSullaCloudRevocationRepository = new PostgresSullaCloudRevocationRepository(db),
    private readonly localCryptoProvider: LocalVaultCryptoProvider = new LocalVaultCryptoProvider(),
    private readonly bitwardenImporter: BitwardenExportImporter = new BitwardenExportImporter(),
  ) {
    this.filesAudit = new FilesAuditEmitter(config);
    if (config.mode === 'desktop') {
      const credentials = [
        ['bootstrap', config.bootstrapServiceToken],
        ['control', config.controlServiceToken],
        ['approval', config.approvalServiceToken],
        ['broker', config.brokerServiceToken],
        ['files', config.filesServiceToken],
      ] as const;
      for (const [name, value] of credentials) {
        if (!value || Buffer.byteLength(value) < 32) throw new Error(`Desktop vault ${ name } credential is not configured`);
      }
      if (new Set(credentials.map(([, value]) => value)).size !== credentials.length) {
        throw new Error('Desktop vault service credentials must be distinct');
      }
    }
  }

  emitFilesAudit(event: Parameters<FilesAuditEmitter['emit']>[0]): void { this.filesAudit.emit(event); }

  /** Seals one item for its `items` row (domain `LocalItemCipher`: fresh item key, AAD binds owner + item id). */
  private async sealItem(plaintext: string, userKey: Uint8Array, context: LocalItemContext): Promise<LocalEncryptedItem> {
    return (await this.localCryptoProvider.get()).sealItem(plaintext, userKey, context);
  }

  /** Opens one `items` row to its exact UTF-8 plaintext. */
  private async openItemText(item: LocalEncryptedItem, userKey: Uint8Array, context: LocalItemContext): Promise<string> {
    return (await this.localCryptoProvider.get()).openItemText(item, userKey, context);
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

  /**
   * Lend a bounded copy of the unlocked user X25519 identity to another
   * Vault-owned component. Lock remains responsive while the operation is in
   * flight; generation checks prevent any result from escaping after a lock or
   * re-unlock, and the private-key copy is always erased.
   */
  async withUnlockedIdentity<T>(
    operation:(identity:UnlockedFilesAuthorityIdentity) => Promise<T>,
  ):Promise<T> {
    const keys = this.requireKeys();
    const generation = this.generation;
    const privateKey = Uint8Array.from(keys.privateKey);
    try {
      const result = await operation({
        principalId: keys.userId,
        publicKey: keys.publicKey,
        privateKey,
        generation,
        assertCurrent: () => this.requireGeneration(generation),
      });
      this.requireGeneration(generation);
      return result;
    } finally {
      privateKey.fill(0);
    }
  }

  /**
   * Lend the unlocked user key to the Passwords sync v3 runner
   * (browserEnvelope/syncRunner.ts) for one operation. Same generation guard
   * as withUnlockedIdentity: a lock during the operation fails it, and the
   * copy is erased afterwards.
   */
  async withUnlockedUserKey<T>(
    operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>,
  ): Promise<T> {
    const keys = this.requireKeys();
    const generation = this.generation;
    const userKey = Uint8Array.from(keys.userKey);
    try {
      const result = await operation({ userId: keys.userId, userKey, assertCurrent: () => this.requireGeneration(generation) });
      this.requireGeneration(generation);
      return result;
    } finally {
      userKey.fill(0);
    }
  }

  /** The Electron main approval identity (also used for Sulla Cloud relay). */
  requireApprovalIdentity(callerId: string, token: string | undefined): void {
    this.requireDesktopIdentity(callerId, token);
  }

  /** Narrow backup-only egress: personal items, fixed field allowlist, and a bound destination. */
  async backupCredentials(itemId:string,kind:'s3'|'nas',target:string):Promise<Record<string,string>> {
    const keys=this.requireKeys(); const generation=this.generation;
    if (!/^[0-9a-f-]{36}$/i.test(itemId)) throw new LocalVaultError('invalid_operation',400,'Backup credential ID is invalid');
    const item=(await this.itemRepository.findOwnedPersonalActive<ItemRow>([itemId,keys.userId])).rows[0];
    if (!item) throw new LocalVaultError('policy_denied',403,'Backup credential is unavailable');
    const plaintext=JSON.parse(await this.openItemText({version:1,ciphertext:item.ciphertext,encryptedItemKey:item.encrypted_item_key},keys.userKey,{itemId:item.id,ownerId:keys.userId})) as VaultItemPlaintext;
    const bound=credentialField(plaintext,'backup_target');
    if (credentialField(plaintext,'backup_kind')!==kind || bound!==target) throw new LocalVaultError('policy_denied',403,'Vault item must bind backup_kind and backup_target to this destination');
    const fields=kind==='s3'?['accessKeyId','secretAccessKey','sessionToken']:['username','password','domain'];
    const result:Record<string,string>={};
    for(const field of fields) { const value=credentialField(plaintext,field); if(value) result[field]=value }
    if(kind==='s3' && (!result.accessKeyId || !result.secretAccessKey)) throw new LocalVaultError('credential_field_missing',400,'S3 backup credentials are incomplete');
    if(kind==='nas' && (!result.username || !result.password)) throw new LocalVaultError('credential_field_missing',400,'SMB backup credentials are incomplete');
    this.requireGeneration(generation);
    return result;
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
    return this.runSecurityOperation(async() => {
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
    });
  }

  async unlockWithPassword(password: string): Promise<{ state: LocalVaultState; cacheUpdateRequired: boolean }> {
    const attemptGeneration = this.generation;
    if (!password || password.length > 1024) throw new LocalVaultError('invalid_credentials', 400, 'Password is required');
    const existing = await this.userRepository.findActiveKdf<{ kdf: unknown }>();
    const crypto = await this.localCryptoProvider.get();
    const stored = existing.rowCount ? crypto.readKdf(existing.rows[0]?.kdf) : undefined;
    const storedPasswordKdf = stored?.passwordKdf();
    if (existing.rowCount && !storedPasswordKdf) {
      throw new LocalVaultError('invalid_credentials', 409, 'This vault requires the OS-protected unlock cache');
    }
    // A fresh vault draws a new salt; an existing one reuses its stored salt and cost exactly.
    const passwordKdf = storedPasswordKdf ?? crypto.credential.newPasswordKdf();
    const masterKey = crypto.credential.deriveMasterKey(password, passwordKdf);
    try {
      const result = await this.activateMasterKey(masterKey, undefined, crypto.kdfColumn(passwordKdf), attemptGeneration);
      // Older builds stored a flat {salt, parameters}; it is upgraded once to the current shape (same key bytes).
      if (stored?.isLegacyFlat) {
        const keys = this.requireKeys();
        await this.userRepository.updateKdf(keys.userId, crypto.kdfColumn(passwordKdf));
      }
      this.stageCacheUpdate(masterKey);
      return { ...result, cacheUpdateRequired: true };
    } finally {
      masterKey.fill(0);
    }
  }

  private async activateMasterKey(
    masterKey: Uint8Array,
    legacyVmk?: Buffer,
    newAccountKdf: unknown = { authority: 'container', version: 1 },
    attemptGeneration = this.generation,
  ): Promise<{ state: LocalVaultState }> {
      const existing = await this.userRepository.findActive<{
        id: string; login_hash_salt: Buffer; login_hash_verifier: Buffer; public_key: string;
        encrypted_private_key: EncryptedEnvelope; encrypted_user_key: EncryptedEnvelope;
      }>();

      const crypto = await this.localCryptoProvider.get();
      let next: UnlockedKeys;
      if (!existing.rowCount) {
        const created = crypto.createAccount(masterKey);
        try {
          const result = await this.userRepository.create<{ id: string }>(
            [created.verifier.salt, created.verifier.verifier, created.publicKey, created.encryptedPrivateKey, created.encryptedUserKey, newAccountKdf],
          );
          next = { userId: result.rows[0].id, publicKey: created.publicKey, userKey: created.userKey, privateKey: created.privateKey, legacyVmk };
        } catch (error) {
          created.userKey.fill(0);
          created.privateKey.fill(0);
          throw error;
        }
      } else {
        const account = existing.rows[0];
        if (!crypto.verifyPassword(masterKey, account.login_hash_salt, account.login_hash_verifier)) {
          throw new LocalVaultError('invalid_credentials', 401, 'Unlock material did not match the vault');
        }
        const userKey = crypto.credential.openUserKey(masterKey, account.encrypted_user_key);
        try {
          next = {
            userId: account.id,
            publicKey: account.public_key,
            userKey,
            privateKey: crypto.credential.openPrivateKey(userKey, account.encrypted_private_key),
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
      this.lockNow();
      this.keys = next;
      this.generation += 1;
      const activeGeneration = this.generation;
      const committed = this.config.legacyDatabaseUrl
        ? await this.migrationRepository.hasCommitted()
        : { rowCount: 1 };
      this.requireGeneration(activeGeneration);
      this.migrationState = committed.rowCount ? 'unlocked' : 'migration_required';
      this.retryPendingSullaCloudRevocations();
      return { state: this.migrationState };
  }

  async lock(): Promise<void> {
    await this.runSecurityOperation(async() => this.lockNow());
  }

  private lockNow(): void {
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

  createHumanSession(callerId: string, token: string | undefined, browserTarget?: BrowserFillTarget): { sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked'; browserTarget?: BrowserFillTarget } {
    this.requireControlIdentity(callerId, token);
    if (browserTarget) {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(browserTarget.tabId)) throw new LocalVaultError('invalid_operation', 400, 'Browser target is invalid');
      let parsed: URL;
      try { parsed = new URL(browserTarget.origin); } catch { throw new LocalVaultError('invalid_destination', 400, 'Browser origin is invalid') }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== browserTarget.origin) {
        throw new LocalVaultError('invalid_destination', 400, 'Browser origin is invalid');
      }
    }
    return this.issueHumanSession(browserTarget);
  }

  private issueHumanSession(browserTarget?: BrowserFillTarget): { sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked'; browserTarget?: BrowserFillTarget } {
    const sessionId = randomBytes(32).toString('base64url');
    const session = {
      csrf: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + HUMAN_SESSION_TTL_MS,
      phase: this.keys ? 'unlocked' as const : 'pre-unlock' as const,
      browserTarget,
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
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Vault is already unlocked');
    const result = await this.unlockWithPassword(password);
    // activateMasterKey invalidates every pre-unlock grant before installing keys.
    const next = this.issueHumanSession(session.browserTarget);
    if (next.phase !== 'unlocked') throw new LocalVaultError('vault_unavailable', 503, 'Vault unlock did not establish an unlocked session');
    return { ...next, phase: 'unlocked', state: result.state, cacheMode: 'helper-update-required' };
    });
  }

  exchangeHumanGrant(sessionId: string | undefined, csrf: string | undefined): {
    sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked'; browserTarget?: BrowserFillTarget;
  } {
    const session = this.validateHumanSession(sessionId, csrf);
    this.humanSessions.delete(sessionId!);
    return this.issueHumanSession(session.browserTarget);
  }

  /**
   * True while no vault user exists yet. The first password submitted to
   * /v1/human/unlock then creates the vault, so the page asks the person to
   * create a password (with confirmation) instead of unlocking one.
   */
  async isSetupRequired(): Promise<boolean> {
    const existing = await this.userRepository.existsActive();
    return !existing.rowCount;
  }

  humanSessionStatus(sessionId: string | undefined, csrf: string | undefined): {
    csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked';
  } {
    const session = this.validateHumanSession(sessionId, csrf);
    return { csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase };
  }

  async lockHumanSession(sessionId: string | undefined, csrf: string | undefined): Promise<{
    sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock'; state: 'locked';
  }> {
    return this.runSecurityOperation(async() => {
      const session = this.validateHumanSession(sessionId, csrf);
      this.lockNow();
      const next = this.issueHumanSession(session.browserTarget);
      if (next.phase !== 'pre-unlock') throw new LocalVaultError('vault_unavailable', 503, 'Vault did not lock');
      return { ...next, phase: 'pre-unlock', state: 'locked' };
    });
  }

  async listHumanItems(sessionId: string | undefined, csrf: string | undefined): Promise<Array<Record<string, unknown>>> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const generation = this.generation;
    const rows = await this.itemRepository.listOwnedActiveByUpdated<ItemRow & { item_type: string; updated_at: string }>([keys.userId]);
    const items = await Promise.all(rows.rows.map(async row => {
      const item = JSON.parse(await this.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      return {
        id: row.id, type: item.type, name: item.name, favorite: item.favorite, username: item.username,
        uris: item.uris, folder: item.folder, agentPolicy: item.agentPolicy,
        integration: item.integration ? { integrationId: item.integration.integrationId, accountId: item.integration.accountId } : undefined,
        revision: Number(row.revision), updatedAt: row.updated_at,
      };
    }));
    this.requireGeneration(generation);
    return items;
    });
  }

  private async prepareBitwardenImport(
    sessionId: string | undefined, csrf: string | undefined,
    input: { content: string; format: 'json'|'csv'|'zip'; password?: string },
  ): Promise<{ preview: BitwardenImportPreview & { duplicates: number; importable: number }; items: VaultItemPlaintext[]; keys: { userId: string; userKey: Uint8Array }; generation: number }> {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const maxContent = input.format === 'zip' ? 34 * 1024 * 1024 : 25 * 1024 * 1024;
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > maxContent) throw new LocalVaultError('invalid_operation', 400, 'Bitwarden exports are limited to 25 MB');
    const keys = this.requireKeys(), generation = this.generation;
    const mapped = await this.readBitwardenExport(input);
    const rows = await this.itemRepository.listOwnedActiveForImport<ItemRow>([keys.userId]);
    const existing = new Set<string>();
    for (const row of rows.rows) {
      const item = JSON.parse(await this.openItemText({ version:1, ciphertext:row.ciphertext, encryptedItemKey:row.encrypted_item_key }, keys.userKey, { itemId:row.id, ownerId:keys.userId })) as VaultItemPlaintext;
      existing.add(this.bitwardenDedupeKey(item));
    }
    const seen = new Set(existing); let duplicates = 0;
    const items = mapped.items.filter(item => { const key=this.bitwardenDedupeKey(item); if(seen.has(key)){duplicates++;return false;} seen.add(key);return true; });
    this.requireGeneration(generation);
    return { preview:{ counts:mapped.counts,total:mapped.total,unmapped:mapped.unmapped,warnings:mapped.warnings,duplicates,importable:items.length }, items, keys, generation };
  }

  /** Parses through @sulla/domain; its failures become route errors ({ error: code }, 400). */
  private async readBitwardenExport(input: BitwardenExportUpload) {
    try {
      return await this.bitwardenImporter.read(input);
    } catch (error) {
      if (this.bitwardenImporter.isImportFailure(error)) throw new LocalVaultError(error.code, 400, error.message);
      throw error;
    }
  }

  private bitwardenDedupeKey(item: VaultItemPlaintext): string {
    const sourceId = item.sourceMetadata?.source === 'bitwarden' && item.sourceMetadata.sourceId;
    if (sourceId) return `bitwarden:${sourceId}`;
    return `content:${createHash('sha256').update(JSON.stringify([item.type,item.name,item.username,item.password,item.totp,item.uris,item.card,item.identity,item.sshKey])).digest('hex')}`;
  }

  async previewBitwardenImport(sessionId: string|undefined, csrf: string|undefined, input: { content:string; format:'json'|'csv'|'zip'; password?:string }): Promise<BitwardenImportPreview & { duplicates:number; importable:number }> {
    return this.runSecurityOperation(async()=> (await this.prepareBitwardenImport(sessionId,csrf,input)).preview);
  }

  async importBitwarden(sessionId: string|undefined, csrf: string|undefined, input: { content:string; format:'json'|'csv'|'zip'; password?:string }): Promise<BitwardenImportPreview & { duplicates:number; importable:number; imported:number }> {
    return this.runSecurityOperation(async()=>{
      const prepared=await this.prepareBitwardenImport(sessionId,csrf,input);
      await this.runTransaction(async client => { for(const item of prepared.items){ const id=randomUUID(); const encrypted=await this.sealItem(JSON.stringify(item),prepared.keys.userKey,{itemId:id,ownerId:prepared.keys.userId}); await this.itemRepository.insertImportedItem([id,prepared.keys.userId,item.type,encrypted.ciphertext,encrypted.encryptedItemKey,item.agentPolicy], client); } });
      this.requireGeneration(prepared.generation);
      await this.auditHumanAction(this.db,prepared.keys.userId,'human_bitwarden_import');
      return {...prepared.preview,imported:prepared.items.length};
    });
  }

  async listHumanItemActivity(
    sessionId: string | undefined, csrf: string | undefined, itemId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const generation = this.generation;
    const params: unknown[] = [keys.userId];
    const itemFilter = itemId ? 'AND a.item_id=$2' : '';
    if (itemId) params.push(itemId);
    const result = await this.auditLogRepository.listOwnedActivity(params, itemFilter);
    this.requireGeneration(generation);
    return result.rows;
    });
  }

  async revealHumanItem(sessionId: string | undefined, csrf: string | undefined, itemId: string): Promise<Record<string, unknown>> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const generation = this.generation;
    const result = await this.itemRepository.findOwnedActiveForReveal<ItemRow>([itemId, keys.userId]);
    const row = result.rows[0];
    if (!row) throw new LocalVaultError('policy_denied', 404, 'Vault item was not found');
    const item = JSON.parse(await this.openItemText(
      { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
      { itemId: row.id, ownerId: keys.userId },
    )) as VaultItemPlaintext;
    this.requireGeneration(generation);
    await this.auditHumanAction(this.db, keys.userId, 'human_item_reveal', row.id, item.name);
    this.requireGeneration(generation);
    return { id: row.id, revision: Number(row.revision), item };
    });
  }

  async saveHumanItem(
    sessionId: string | undefined, csrf: string | undefined,
    input: { id?: string; revision?: number; item: VaultItemPlaintext },
  ): Promise<{ id: string; revision: number }> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const generation = this.generation;
    if (!input.item || typeof input.item.name !== 'string' || !input.item.name.trim() || !input.item.agentPolicy) {
      throw new LocalVaultError('invalid_operation', 400, 'Vault item is invalid');
    }
    const policy = input.item.agentPolicy;
    if (!['only_me', 'agents'].includes(policy.mode) || !['metadata', 'autofill', 'full'].includes(policy.level) ||
        !Array.isArray(policy.agents) || !policy.agents.every(value => typeof value === 'string') ||
        !Array.isArray(policy.sites) || !policy.sites.every(value => typeof value === 'string') ||
        (policy.expiresAt !== null && (typeof policy.expiresAt !== 'string' || !Number.isFinite(Date.parse(policy.expiresAt))))) {
      throw new LocalVaultError('invalid_operation', 400, 'Agent access policy is invalid');
    }
    const id = input.id ?? randomUUID();
    const item: VaultItemPlaintext = { ...input.item };
    if (item.customFields !== undefined) {
      // Unknown types (from a newer client) may only round-trip when the stored item already had them.
      const raw: unknown = item.customFields;
      const hasUnknownType = Array.isArray(raw) && raw.some(field => !isKnownCustomFieldType((field as { type?: unknown } | null)?.type));
      const preserved = input.id && hasUnknownType ? await this.storedCustomFields(keys, input.id) : [];
      this.requireGeneration(generation);
      const checked = validateCustomFields(raw, { preserved });
      if (!checked.ok) throw new LocalVaultError('invalid_operation', 400, checked.error);
      if (checked.fields.length) item.customFields = checked.fields;
      else delete item.customFields;
    }
    if (item.proxy !== undefined) {
      const checked = validateVaultItemProxy(item);
      if (!checked.ok) throw new LocalVaultError('invalid_operation', 400, checked.error);
      item.proxy = checked.proxy;
    }
    const encrypted = await this.sealItem(JSON.stringify(item), keys.userKey, { itemId: id, ownerId: keys.userId });
    const result = await this.runTransaction(async client => {
      if (!input.id) {
      const created = await this.itemRepository.insertHumanItem<{ revision: number }>([id, keys.userId, input.item.type, encrypted.ciphertext, encrypted.encryptedItemKey, input.item.agentPolicy,
          input.item.integration ? `${ input.item.integration.integrationId }/${ input.item.integration.accountId }` : null], client);
      this.requireGeneration(generation);
      await this.auditHumanAction(client, keys.userId, 'human_item_created', id, input.item.name);
      this.requireGeneration(generation);
      return { id, revision: Number(created.rows[0].revision) };
      }
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new LocalVaultError('invalid_operation', 400, 'Item revision is required');
    const updated = await this.itemRepository.updateHumanItemIfRevision<{ revision: number }>([input.item.type, encrypted.ciphertext, encrypted.encryptedItemKey, input.item.agentPolicy,
        input.item.integration ? `${ input.item.integration.integrationId }/${ input.item.integration.accountId }` : null,
        id, keys.userId, revision], client);
    if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; reload and retry');
    this.requireGeneration(generation);
    await this.auditHumanAction(client, keys.userId, 'human_item_updated', id, input.item.name);
    this.requireGeneration(generation);
    return { id, revision: Number(updated.rows[0].revision) };
    });
    return result;
    });
  }

  /** Decrypts only the custom fields of a stored item; used to let unknown field types round-trip. */
  private async storedCustomFields(keys: { userId: string; userKey: Uint8Array }, itemId: string): Promise<VaultItemCustomField[]> {
    const result = await this.itemRepository.findOwnedActiveCustomFields<ItemRow>([itemId, keys.userId]);
    const row = result.rows[0];
    if (!row) return [];
    const stored = JSON.parse(await this.openItemText(
      { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
      { itemId: row.id, ownerId: keys.userId },
    )) as VaultItemPlaintext;
    return Array.isArray(stored.customFields) ? stored.customFields : [];
  }

  async deleteHumanItem(sessionId: string | undefined, csrf: string | undefined, itemId: string, revision: number): Promise<void> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    const keys = this.requireKeys();
    const generation = this.generation;
    await this.runTransaction(async client => {
    const result = await this.itemRepository.softDeleteOwnedIfRevision([itemId, keys.userId, revision], client);
    if (!result.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; reload and retry');
    this.requireGeneration(generation);
    await this.auditHumanAction(client, keys.userId, 'human_item_deleted', itemId);
    this.requireGeneration(generation);
    });
    });
  }

  async changeHumanPassword(
    sessionId: string | undefined, csrf: string | undefined, currentPassword: string, nextPassword: string,
  ): Promise<{ cacheMode: 'helper-update-required' }> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (!currentPassword || !nextPassword) throw new LocalVaultError('invalid_credentials', 400, 'Current and new passwords are required');
    const keys = this.requireKeys();
    const generation = this.generation;
    const account = await this.userRepository.findCredentials<{
      login_hash_salt: Buffer; login_hash_verifier: Buffer;
      kdf: unknown;
    }>(keys.userId);
    const crypto = await this.localCryptoProvider.get();
    const stored = account.rows[0]?.kdf as { password?: unknown } | undefined;
    const passwordKdf = stored?.password ? crypto.readKdf(stored)?.passwordKdf() : undefined;
    if (!passwordKdf) throw new LocalVaultError('invalid_credentials', 409, 'Password unlock is not configured');
    const nextKdf = crypto.credential.newPasswordKdf();
    const current = crypto.credential.deriveMasterKey(currentPassword, passwordKdf);
    const next = crypto.credential.deriveMasterKey(nextPassword, nextKdf);
    try {
      if (!crypto.verifyPassword(current, account.rows[0].login_hash_salt, account.rows[0].login_hash_verifier)) {
        throw new LocalVaultError('invalid_credentials', 401, 'Current password is invalid');
      }
      const verifier = crypto.newVerifier(next);
      const wrapped = crypto.credential.sealUserKey(next, keys.userKey);
      await this.runTransaction(async client => {
      await this.rewrapHistory.preserveCurrentPasswordWrap(keys.userId, 'password_change', client);
      await this.userRepository.updatePassword(keys.userId, [
        verifier.salt, verifier.verifier, wrapped, crypto.kdfColumn(nextKdf),
      ], client);
      this.requireGeneration(generation);
      await this.auditHumanAction(client, keys.userId, 'human_password_changed');
      this.requireGeneration(generation);
      });
      this.stageCacheUpdate(next);
      return { cacheMode: 'helper-update-required' };
    } finally {
      current.fill(0);
      next.fill(0);
    }
    });
  }

  /** Record Cloud ownership metadata without changing the local user-key wrap. */
  async rewrapForAccountPassword(
    serviceId: string, token: string | undefined, input: AccountPasswordRewrapRequest,
  ): Promise<AccountPasswordRewrapResponse> {
    this.requireApprovalIdentity(serviceId, token);
    const kdf = input?.kdf;
    const cloudUserId = typeof input?.cloudUserId === 'string' ? input.cloudUserId.trim() : '';
    if (!cloudUserId || Buffer.byteLength(cloudUserId) > 256) {
      throw new LocalVaultError('invalid_operation', 400, 'Cloud account is invalid');
    }
    if (kdf?.alg !== 'argon2id13' || !/^[A-Za-z0-9_-]{22}$/.test(kdf.salt) ||
        kdf.memoryBytes !== 67_108_864 || kdf.ops !== 3) {
      throw new LocalVaultError('invalid_operation', 400, 'Account KDF is unsupported');
    }
    const masterKey = Buffer.from(input.masterKey || '', 'base64url');
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.masterKey || '') || masterKey.byteLength !== 32) {
      masterKey.fill(0);
      throw new LocalVaultError('invalid_unlock_material', 400, 'Account master key is invalid');
    }
    const response = { migrated: false, recoveryCreated: false, cacheMode: 'helper-update-required' } as const;
    // A fresh install has no local key wrap to rewrite: bootstrap the new vault
    // once. An existing locked vault remains a strict no-op, aside from owner guard.
    const keys = this.keys;
    if (!keys) {
      try {
        await this.runSecurityOperation(async() => {
          if (this.keys || !await this.isSetupRequired()) return false;
          await this.activateMasterKey(Uint8Array.from(masterKey), undefined, {
            authority: 'container', version: 1, cloudUserId,
            password: { salt: kdf.salt, parameters: { memoryBytes: kdf.memoryBytes, operations: kdf.ops } },
          });
          return true;
        });
        if (!this.keys) {
          const existing = await this.userRepository.findActiveOwner<{ id: string; kdf: { cloudUserId?: string } }>();
          const owner = existing.rows[0]?.kdf?.cloudUserId;
          if (owner && owner !== cloudUserId) {
            throw new LocalVaultError('invalid_credentials', 409, 'This Mac has a vault for a different Sulla account. Sign in with that account.');
          }
        }
        return response;
      } finally { masterKey.fill(0); }
    }

    try {
    const current = await this.userRepository.findCredentials<{
      kdf: { cloudUserId?: string; password?: { salt?: string; parameters?: { memoryBytes?: number; operations?: number } } };
    }>(keys.userId);
    if (!current.rows.length) throw new LocalVaultError('invalid_credentials', 404, 'Local vault owner was not found');
    const currentOwner = current.rows[0].kdf?.cloudUserId;
    if (currentOwner && currentOwner !== cloudUserId) {
      throw new LocalVaultError('invalid_credentials', 409, 'This Mac has a vault for a different Sulla account. Sign in with that account.');
    }
    if (!currentOwner) {
      const priorCloud = await this.db.query<{ active_account_id: string }>(
        `SELECT active_account_id FROM local_integration_state
          WHERE owner_user_id=$1 AND integration_id='sulla-cloud' LIMIT 1`, [keys.userId],
      );
      if (priorCloud.rows[0]?.active_account_id && priorCloud.rows[0].active_account_id !== cloudUserId) {
        throw new LocalVaultError('invalid_credentials', 409, 'This Mac has a vault for a different Sulla account. Sign in with that account.');
      }
      await this.userRepository.updateKdf(keys.userId, {
        authority: 'container', version: 1, cloudUserId,
        ...(current.rows[0].kdf?.password ? { password: current.rows[0].kdf.password } : {}),
      });
    }
    return response;
    } finally { masterKey.fill(0); }
  }

  async wrapVaultEnrollment(serviceId:string, token:string|undefined, input:VaultEnrollmentWrapRequest):Promise<{wrappedUserKey:TransportEnvelope}> {
    this.requireApprovalIdentity(serviceId, token);
    if (input?.approved !== true) throw new LocalVaultError('approval_required', 428, 'Vault enrollment was not approved');
    const keys=this.requireKeys();
    const env=await this.codecProvider.get();
    const bundle=input.bundle as SyncBundle, head=input.head as SyncHead;
    env.verifyBundle(bundle,keys.userKey);
    if(head?.vaultId!==input.vaultId||head.scope!=='personal')throw new LocalVaultError('invalid_operation',409,'Cloud head does not match this vault');
    const payload=Buffer.from(JSON.stringify({userKey:Buffer.from(keys.userKey).toString('base64url'),bundle,head,...(input.records===undefined?{}:{records:input.records})}));
    try{return{wrappedUserKey:await this.filesTransport.wrap(payload,input.publicKey,input.requestId,input.vaultId,input.vaultEpoch)}}finally{payload.fill(0)}
  }

  async adoptVaultEnrollment(serviceId:string, token:string|undefined, input:VaultEnrollmentAdoptRequest):Promise<{bundleMac:string;headMac:string}> {
    this.requireApprovalIdentity(serviceId,token);
    if(!await this.isSetupRequired())throw new LocalVaultError('vault_exists',409,'A local vault already exists');
    const masterKey=Buffer.from(input.masterKey||'','base64url');
    if(masterKey.byteLength!==32)throw new LocalVaultError('invalid_unlock_material',400,'Account master key is invalid');
    let userKey:Uint8Array|undefined, privateKey:Uint8Array|undefined, plain:Uint8Array|undefined;
    try{
      const e=input.wrappedUserKey as TransportEnvelope;
      const recipient=await globalThis.crypto.subtle.importKey('jwk',input.privateKeyJwk,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
      plain=await this.filesTransport.unwrap(e,recipient,input.requestId,input.vaultId,input.vaultEpoch);
      const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)) as {userKey:string;bundle:SyncBundle;head:SyncHead};
      userKey=Buffer.from(payload.userKey,'base64url'); if(userKey.byteLength!==32)throw new Error('bad user key');
      const env=await this.codecProvider.get(); env.verifyBundle(payload.bundle,userKey);
      if(payload.head?.vaultId!==input.vaultId||payload.head.scope!=='personal')throw new Error('bad head');
      const wrapped=(await this.keyEnvelopeReaderProvider.get()).unwrapUserKey(payload.bundle.encryptedUserKey,masterKey); if(!timingSafeEqual(Buffer.from(wrapped),Buffer.from(userKey)))throw new Error('bundle key mismatch'); wrapped.fill(0);
      privateKey=(await this.keyEnvelopeReaderProvider.get()).unwrapUserPrivateKey(payload.bundle.encryptedPrivateKey,userKey);
      this.pendingVaultEnrollments.set(input.requestId,{expiresAt:Date.now()+60_000,bundle:payload.bundle,head:payload.head,userKey:Uint8Array.from(userKey),privateKey:Uint8Array.from(privateKey),masterKey:Uint8Array.from(masterKey),cloudUserId:input.cloudUserId});
      return{bundleMac:payload.bundle.mac,headMac:payload.head.mac};
    }catch(error){throw error instanceof LocalVaultError?error:new LocalVaultError('invalid_proof',403,'Vault enrollment could not be verified')}finally{masterKey.fill(0);userKey?.fill(0);privateKey?.fill(0);plain?.fill(0)}
  }

  async commitVaultEnrollment(serviceId:string,token:string|undefined,requestId:string):Promise<{adopted:true}>{
    this.requireApprovalIdentity(serviceId,token); const staged=this.pendingVaultEnrollments.get(requestId); this.pendingVaultEnrollments.delete(requestId);
    if(!staged||staged.expiresAt<Date.now())throw new LocalVaultError('invalid_operation',409,'Vault enrollment expired');
    try{ if(!await this.isSetupRequired())throw new LocalVaultError('vault_exists',409,'A local vault already exists'); const b=staged.bundle;
      const verifier=makeLoginVerifier(await deriveLoginHash(staged.masterKey));
      await this.runTransaction(async client => {
        await this.userRepository.createWithId([
          b.vaultUserId,
          verifier.salt,
          verifier.verifier,
          b.publicKey,
          b.encryptedPrivateKey,
          b.encryptedUserKey,
          { authority: 'container', version: 1, cloudUserId: staged.cloudUserId, password: { salt: b.kdf.salt, parameters: { memoryBytes: b.kdf.memoryBytes, operations: b.kdf.ops } } },
        ], client);
        await this.syncStateRepository.create([
          b.vaultUserId,
          b.vaultId,
          b.epoch,
          b.bundleGeneration,
          createHash('sha256').update(JSON.stringify(b)).digest('hex'),
        ], client);
      });
      this.lockNow();this.keys={userId:b.vaultUserId,publicKey:b.publicKey,userKey:Uint8Array.from(staged.userKey),privateKey:Uint8Array.from(staged.privateKey)};this.generation+=1;this.migrationState='unlocked';this.stageCacheUpdate(staged.masterKey);return{adopted:true};
    }finally{staged.userKey.fill(0);staged.privateKey.fill(0);staged.masterKey.fill(0)}
  }

  /** Build a reset relay envelope only after the native approval prompt returned an explicit tap. */
  async wrapUserKeyForApprovedDevice(
    serviceId: string, token: string | undefined, input: VaultDeviceApprovalWrapRequest,
  ): Promise<{ wrappedUserKey: Awaited<ReturnType<typeof transportWrap>> }> {
    this.requireApprovalIdentity(serviceId, token);
    if (input?.approved !== true) throw new LocalVaultError('approval_required', 428, 'Vault access was not approved');
    const keys = this.requireKeys();
    const state = await this.syncStateRepository.find<{ vault_id: string; epoch: number | string }>(keys.userId);
    const row = state.rows[0];
    if (!row || row.vault_id !== input.vaultId || Number(row.epoch) !== input.vaultEpoch) {
      throw new LocalVaultError('invalid_operation', 409, 'Approval request does not match this vault');
    }
    return { wrappedUserKey: await transportWrap(keys.userKey, input.publicKey, input.requestId, input.vaultId, input.vaultEpoch) };
  }

  /** Replace the account recovery wrap while retaining the previous encrypted wrap as a restore point. */
  async rotateAccountRecoveryKey(
    serviceId: string, token: string | undefined,
  ): Promise<{ recoveryKey: string; replacedExisting: boolean }> {
    this.requireApprovalIdentity(serviceId, token);
    const keys = this.requireKeys();
    const generation = this.generation;
    const rotation = (await this.localCryptoProvider.get()).recovery.rotate(keys.userKey);
    let replacedExisting = false;
    await this.runTransaction(async client => {
      replacedExisting = await this.rewrapHistory.preserveCurrentRecoveryWrap(keys.userId, 'rotation', client);
      await this.recoveryRepository.upsertForRotation([keys.userId, rotation.row.recoverySalt, rotation.row.recoveryVerifier, rotation.row.encryptedUserKey], client);
      this.requireGeneration(generation);
      await this.auditHumanAction(client, keys.userId, 'account_recovery_key_rotated');
    });
    return { recoveryKey: rotation.recoveryKey, replacedExisting };
  }

  async configureHumanRecovery(
    sessionId: string | undefined, csrf: string | undefined, recoveryCode: string,
  ): Promise<void> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (recoveryCode.length < 12) throw new LocalVaultError('invalid_credentials', 400, 'Recovery code is too short');
    const keys = this.requireKeys();
    const generation = this.generation;
    const row = (await this.localCryptoProvider.get()).recovery.configure(keys.userKey, recoveryCode);
    await this.runTransaction(async client => {
    await this.recoveryRepository.upsertForHumanRecovery([keys.userId, row.recoverySalt, row.recoveryVerifier, row.encryptedUserKey], client);
    this.requireGeneration(generation);
    await this.auditHumanAction(client, keys.userId, 'human_recovery_configured');
    this.requireGeneration(generation);
    });
    });
  }

  async recoverHumanSession(
    sessionId: string | undefined, csrf: string | undefined, recoveryCode: string, nextPassword: string,
  ): Promise<{ sessionId: string; csrf: string; expiresAt: number; phase: 'unlocked'; state: LocalVaultState; cacheMode: 'helper-update-required' }> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Recovery requires a locked vault');
    const attemptGeneration = this.generation;
    const result = await this.recoveryRepository.findAny<{ user_id: string; recovery_salt: string; recovery_verifier: string; encrypted_user_key: EncryptedEnvelope }>();
    if (!result.rowCount) throw new LocalVaultError('invalid_credentials', 404, 'Vault recovery is not configured');
    const row = result.rows[0];
    const crypto = await this.localCryptoProvider.get();
    const nextKdf = crypto.credential.newPasswordKdf();
    const next = crypto.credential.deriveMasterKey(nextPassword, nextKdf);
    let recoveredUserKey: Uint8Array | undefined;
    try {
      try {
        recoveredUserKey = crypto.recovery.open(
          { recoverySalt: row.recovery_salt, recoveryVerifier: row.recovery_verifier, encryptedUserKey: row.encrypted_user_key }, recoveryCode);
      } catch (error) {
        if (error instanceof VaultOperationError && error.code === 'invalid_credential') {
          throw new LocalVaultError('invalid_credentials', 401, 'Recovery code is invalid');
        }
        throw error;
      }
      const verifier = crypto.newVerifier(next);
      const wrapped = crypto.credential.sealUserKey(next, recoveredUserKey);
      await this.runTransaction(async client => {
      await this.rewrapHistory.preserveCurrentPasswordWrap(row.user_id, 'recovery', client);
      await this.userRepository.updatePassword(row.user_id, [
        verifier.salt, verifier.verifier, wrapped, crypto.kdfColumn(nextKdf),
      ], client);
      this.requireStableGeneration(attemptGeneration);
      await this.auditHumanAction(client, row.user_id, 'human_recovery_unlocked');
      });
      const unlocked = await this.activateMasterKey(next, undefined, crypto.kdfColumn(nextKdf), attemptGeneration);
      this.stageCacheUpdate(next);
      const rotated = this.issueHumanSession();
      if (rotated.phase !== 'unlocked') throw new LocalVaultError('vault_unavailable', 503, 'Recovery did not unlock the vault');
      return { ...rotated, phase: 'unlocked', state: unlocked.state, cacheMode: 'helper-update-required' };
    } finally {
      next.fill(0);
      recoveredUserKey?.fill(0);
    }
    });
  }

  async exportHumanBackup(
    sessionId: string | undefined, csrf: string | undefined, backupPassword: string,
  ): Promise<HumanBackupEnvelope> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'unlocked') throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
    if (!backupPassword) throw new LocalVaultError('invalid_credentials', 400, 'Backup password is required');
    const keys = this.requireKeys();
    const generation = this.generation;
    const [user, items, recovery] = await Promise.all([
      this.userRepository.findById<VaultUserBackupRow>(keys.userId),
      this.itemRepository.listOwnedForBackup([keys.userId]),
      this.recoveryRepository.findForUser(keys.userId),
    ]);
    const envelope = (await this.localCryptoProvider.get()).backups.seal(
      { user: user.rows[0], items: items.rows, recovery: recovery.rows[0] ?? null }, backupPassword);
    this.requireGeneration(generation);
    await this.auditHumanAction(this.db, keys.userId, 'human_backup_exported');
    this.requireGeneration(generation);
    return envelope;
    });
  }

  async importHumanBackup(
    sessionId: string | undefined, csrf: string | undefined, backupPassword: string, backupEnvelope: HumanBackupEnvelope,
  ): Promise<void> {
    return this.runSecurityOperation(async() => {
    const session = this.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Backup import requires a locked vault');
    if (!backupPassword || backupEnvelope?.version !== 1) throw new LocalVaultError('invalid_operation', 400, 'Backup input is invalid');
    const attemptGeneration = this.generation;
    const existing = await this.userRepository.exists();
    if (existing.rowCount) throw new LocalVaultError('policy_denied', 409, 'Backup import requires an empty local vault');
    const backups = (await this.localCryptoProvider.get()).backups;
    try {
      const payload = backups.open(backupEnvelope, backupPassword);
      const asBuffer = DesktopHumanBackup.bytea;
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await this.userRepository.importBackup(
          [payload.user.id, payload.user.email, asBuffer(payload.user.login_hash_salt), asBuffer(payload.user.login_hash_verifier),
            payload.user.public_key, payload.user.encrypted_private_key, payload.user.encrypted_user_key, payload.user.kdf],
          client,
        );
        for (const item of payload.items) {
          await this.itemRepository.insertBackupItem([item.id, payload.user.id, item.item_type, item.ciphertext, item.encrypted_item_key, item.agent_policy,
              item.integration_ref, item.revision, item.created_at, item.updated_at], client);
        }
        if (payload.recovery) {
          await this.recoveryRepository.insert(
            [payload.user.id, payload.recovery.recovery_salt, payload.recovery.recovery_verifier, payload.recovery.encrypted_user_key],
            client,
          );
        }
        this.requireStableGeneration(attemptGeneration);
        await this.auditHumanAction(client, payload.user.id, 'human_backup_imported');
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
    }
    });
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

  private validateAgentWriteClaims(claims: BrokerClaims, callerId: string, token: string | undefined): UnlockedKeys {
    this.requireBrokerIdentity(callerId, token);
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    const keys = this.requireKeys();
    if (claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    return keys;
  }

  private generatedPassword(): string {
    // 192 random bits, encoded without ambiguous punctuation; generation stays inside Vault.
    return randomBytes(24).toString('base64url');
  }

  async createAgentVaultItem(
    callerId: string, token: string | undefined, input: BrokerVaultItemWriteRequest,
  ): Promise<BrokerVaultItemWriteResponse> {
    return this.runSecurityOperation(async() => {
      const keys = this.validateAgentWriteClaims(input?.claims, callerId, token);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 200) throw new LocalVaultError('invalid_operation', 400, 'Item title is invalid');
      if ((input.password === undefined) === (input.generate !== true)) {
        throw new LocalVaultError('invalid_operation', 400, 'Provide exactly one of password or generate:true');
      }
      const password = input.generate === true ? this.generatedPassword() : String(input.password);
      if (!password || Buffer.byteLength(password) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('invalid_operation', 400, 'Password is invalid');
      const id = randomUUID();
      const sites = input.url ? [new URL(input.url).hostname] : [];
      const item: VaultItemPlaintext = {
        type: 'login', name: title, username: input.username, password,
        uris: input.url ? [{ uri: input.url }] : undefined, notes: input.notes, folder: input.folder,
        tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean).slice(0, 50) : undefined,
        agentPolicy: { mode: 'agents', level: 'metadata', agents: [input.claims.agent_id], sites, expiresAt: null, askFirst: false, allowServerAgents: false },
      };
      const encrypted = await this.sealItem(JSON.stringify(item), keys.userKey, { itemId: id, ownerId: keys.userId });
      const generation = this.generation;
      const result = await this.runTransaction(async client => {
        const created = await this.itemRepository.insertAgentItem<{ revision: number }>([id, keys.userId, item.type, encrypted.ciphertext, encrypted.encryptedItemKey, item.agentPolicy], client);
        this.requireGeneration(generation);
        await this.auditLogRepository.recordAgentCreated([keys.userId, id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
        return Number(created.rows[0].revision);
      });
      return { itemId: id, revision: result, generated: input.generate === true };
    });
  }

  async updateAgentVaultItem(
    callerId: string, token: string | undefined, input: BrokerVaultItemUpdateRequest,
  ): Promise<BrokerVaultItemWriteResponse> {
    return this.runSecurityOperation(async() => {
      const keys = this.validateAgentWriteClaims(input?.claims, callerId, token);
      if (!UUID_PATTERN.test(input.itemId)) throw new LocalVaultError('invalid_operation', 400, 'Item reference is invalid');
      const owned = await this.auditLogRepository.wasCreatedByAgentForUpdate([input.itemId, input.claims.agent_id]);
      if (!owned.rowCount) throw new LocalVaultError('policy_denied', 403, 'Agents may update only vault items they created');
      const rows = await this.itemRepository.findOwnedActiveForAgentUpdate<ItemRow>([input.itemId, keys.userId]);
      const row = rows.rows[0];
      if (!row) throw new LocalVaultError('policy_denied', 404, 'Vault item was not found');
      const item = JSON.parse(await this.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      if (input.password !== undefined && input.generate === true) throw new LocalVaultError('invalid_operation', 400, 'Provide password or generate:true, not both');
      if (input.password !== undefined) item.password = String(input.password);
      if (input.generate === true) item.password = this.generatedPassword();
      if (input.title !== undefined) item.name = String(input.title).trim();
      if (input.username !== undefined) item.username = String(input.username);
      if (input.url !== undefined) item.uris = [{ uri: String(input.url) }];
      if (input.notes !== undefined) item.notes = String(input.notes);
      if (input.folder !== undefined) item.folder = String(input.folder);
      if (input.tags !== undefined) item.tags = input.tags.map(String).filter(Boolean).slice(0, 50);
      const encrypted = await this.sealItem(JSON.stringify(item), keys.userKey, { itemId: row.id, ownerId: keys.userId });
      const generation = this.generation;
      const revision = await this.runTransaction(async client => {
        const updated = await this.itemRepository.updateOwnedCiphertextIfRevision<{ revision: number }>([encrypted.ciphertext, encrypted.encryptedItemKey, row.id, keys.userId, row.revision], client);
        if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; retry');
        this.requireGeneration(generation);
        await this.auditLogRepository.recordAgentUpdated([keys.userId, row.id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
        return Number(updated.rows[0].revision);
      });
      return { itemId: row.id, revision, generated: input.generate === true };
    });
  }

  async setAgentIntegrationCredential(
    callerId: string, token: string | undefined, input: BrokerIntegrationCredentialWriteRequest,
  ): Promise<BrokerVaultItemWriteResponse> {
    return this.runSecurityOperation(async() => {
      const integrationId = String(input.integrationId ?? '').trim();
      const accountId = String(input.accountId ?? 'default').trim();
      const property = String(input.property ?? '').trim();
      if (![integrationId, accountId, property].every(value => /^[A-Za-z0-9._-]{1,128}$/.test(value))) {
        throw new LocalVaultError('invalid_operation', 400, 'Credential reference is invalid');
      }
      const keys = this.validateAgentWriteClaims(input.claims, callerId, token);
      const existing = await this.itemRepository.findOwnedIntegrationCredential<ItemRow>([keys.userId, `${ integrationId }/${ accountId }`]);
      if (!existing.rowCount) {
        const result = await this.createAgentIntegrationItem(keys, input, integrationId, accountId, property);
        return result;
      }
      const row = existing.rows[0];
      const owned = await this.auditLogRepository.wasCreatedByAgentForIntegration([row.id, input.claims.agent_id]);
      if (!owned.rowCount) throw new LocalVaultError('policy_denied', 403, 'Agents may update only credentials they created');
      const item = JSON.parse(await this.openItemText({ version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey, { itemId: row.id, ownerId: keys.userId })) as VaultItemPlaintext;
      item.integration ??= { integrationId, accountId, properties: {} };
      item.integration.properties[property] = String(input.value);
      const encrypted = await this.sealItem(JSON.stringify(item), keys.userKey, { itemId: row.id, ownerId: keys.userId });
      const updated = await this.runTransaction(async client => {
        const result = await this.itemRepository.updateCiphertextIfRevision<{ revision: number }>([encrypted.ciphertext, encrypted.encryptedItemKey, row.id, row.revision], client);
        if (!result.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; retry');
        await this.auditLogRepository.recordIntegrationAgentUpdated([keys.userId, row.id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
        return Number(result.rows[0].revision);
      });
      return { itemId: row.id, revision: updated, generated: false };
    });
  }

  private async createAgentIntegrationItem(keys: UnlockedKeys, input: BrokerIntegrationCredentialWriteRequest, integrationId: string, accountId: string, property: string): Promise<BrokerVaultItemWriteResponse> {
    const id = randomUUID();
    const item: VaultItemPlaintext = { type: 'login', name: `${ integrationId } (${ accountId })`, integration: { integrationId, accountId, properties: { [property]: String(input.value) } }, agentPolicy: { mode: 'agents', level: 'metadata', agents: [input.claims.agent_id], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false } };
    const encrypted = await this.sealItem(JSON.stringify(item), keys.userKey, { itemId: id, ownerId: keys.userId });
    const revision = await this.runTransaction(async client => {
      const created = await this.itemRepository.insertAgentIntegrationItem<{ revision: number }>([id, keys.userId, item.type, encrypted.ciphertext, encrypted.encryptedItemKey, item.agentPolicy, `${ integrationId }/${ accountId }`], client);
      await this.auditLogRepository.recordIntegrationAgentCreated([keys.userId, id, input.claims.pod_id, { agentId: input.claims.agent_id }], client);
      return Number(created.rows[0].revision);
    });
    return { itemId: id, revision, generated: false };
  }

  async integrationMetadata(
    callerId: string, token: string | undefined, integrationId: string, accountFilter?: string,
  ): Promise<import('./contracts.js').BrokerIntegrationMetadataResponse> {
    this.requireBrokerIdentity(callerId, token);
    return this.readIntegrationMetadata(integrationId, accountFilter);
  }

  private async readIntegrationMetadata(
    integrationId: string, accountFilter?: string,
  ): Promise<import('./contracts.js').BrokerIntegrationMetadataResponse> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration identifier is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    const result = await this.itemRepository.listIntegrationMetadata<ItemRow & { integration_ref: string }>([keys.userId, integrationId, accountFilter ?? null]);
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
      const plaintext = JSON.parse(await this.openItemText(
        { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
        keys.userKey,
        { itemId: item.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      this.requireGeneration(generation);
      const sourceProperties = plaintext.integration?.properties ?? {};
      const properties = safeIntegrationMetadata(sourceProperties, integrationId);
      const accountId = item.integration_ref.slice(integrationId.length + 1);
      const explicitStatus = properties.connection_status?.toLowerCase();
      const hasCredential = Object.entries(sourceProperties)
        .some(([name, value]) => CREDENTIAL_PROPERTY_PATTERN.test(name) && typeof value === 'string' && value.length > 0);
      const credentialRequired = Object.keys(sourceProperties).some(name => CREDENTIAL_PROPERTY_PATTERN.test(name));
      return {
        accountId,
        label: properties.account_label || accountId,
        connected: explicitStatus ? ['connected', 'true'].includes(explicitStatus) : hasCredential,
        credentialRequired,
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
    const exists = await this.itemRepository.existsByIntegrationRefForActivation([keys.userId, `${ integrationId }/${ accountId }`]);
    this.requireGeneration(generation);
    if (!exists.rowCount) throw new LocalVaultError('invalid_operation', 404, 'Integration account is unavailable');
    await this.integrationStateRepository.upsert(keys.userId, integrationId, accountId);
    this.requireGeneration(generation);
    return this.integrationMetadata(callerId, token, integrationId);
  }

  /**
   * Create the empty account a first OAuth sign-in writes its tokens into.
   * oauth.exchange only updates an existing item, so without this a new
   * Codex/Grok sign-in had nowhere to land. Desktop identity only, built-in
   * OAuth integrations only, metadata only: no secret crosses this call.
   */
  async ensureOAuthAccount(
    callerId: string, token: string | undefined, integrationId: string, input: BrokerOAuthAccountRequest,
  ): Promise<import('./contracts.js').BrokerIntegrationMetadataResponse> {
    this.requireDesktopIdentity(callerId, token);
    const accountId = input?.accountId;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || typeof accountId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account identifier is invalid');
    }
    if (!isNativeOAuthIntegration(integrationId)) {
      throw new LocalVaultError('policy_denied', 403, 'Integration has no built-in OAuth sign-in');
    }
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 120) : accountId;
    const keys = this.requireKeys();
    const generation = this.generation;
    const integrationRef = `${ integrationId }/${ accountId }`;
    const exists = await this.itemRepository.existsByIntegrationRefForOAuth([keys.userId, integrationRef]);
    this.requireGeneration(generation);
    if (!exists.rowCount) {
      // Same default as the vault's guided Connect screen with "agents can use this" on.
      const policy = {
        mode: 'agents' as const, level: 'autofill' as const, agents: [], sites: [], expiresAt: null,
        askFirst: false, allowServerAgents: false,
      };
      const itemId = randomUUID();
      const plaintext: VaultItemPlaintext = {
        type: 'apiKey', name: label, agentPolicy: policy,
        integration: { integrationId, accountId, properties: { account_label: label } },
      };
      const encrypted = await this.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
      await this.runSecurityOperation(() => this.runTransaction(async client => {
        this.requireGeneration(generation);
        await this.itemRepository.insertOAuthAccount([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy, integrationRef], client);
        await this.auditHumanAction(client, keys.userId, 'oauth_account_created', itemId, label);
        this.requireGeneration(generation);
      }));
    }
    return this.readIntegrationMetadata(integrationId, accountId);
  }

  /** Trusted Desktop handoff for credentials collected by first-run and Connect UI. */
  async importDesktopIntegrationAccount(
    callerId: string, token: string | undefined, integrationId: string, input: BrokerIntegrationAccountImportRequest,
  ): Promise<import('./contracts.js').BrokerIntegrationMetadataResponse> {
    this.requireDesktopIdentity(callerId, token);
    const accountId = String(input?.accountId ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(integrationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(accountId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account identifier is invalid');
    }
    if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) {
      throw new LocalVaultError('invalid_operation', 400, 'Integration account values are invalid');
    }
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [property, value] of Object.entries(input.values)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(property) || typeof value !== 'string') {
        throw new LocalVaultError('invalid_operation', 400, 'Integration account value is invalid');
      }
      values[property] = value;
    }
    const label = typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 120)
      : (values.account_label || accountId);
    values.account_label = label;
    if (input.connected !== undefined) values.connection_status = input.connected ? 'connected' : 'disconnected';

    const keys = this.requireKeys();
    const generation = this.generation;
    const integrationRef = `${ integrationId }/${ accountId }`;
    const existing = await this.itemRepository.findOwnedIntegrationAccount<ItemRow>([keys.userId, integrationRef]);
    this.requireGeneration(generation);
    const itemId = existing.rows[0]?.id ?? randomUUID();
    let plaintext: VaultItemPlaintext;
    if (existing.rowCount) {
      const row = existing.rows[0];
      plaintext = JSON.parse(await this.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key },
        keys.userKey, { itemId, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      plaintext.integration ??= { integrationId, accountId, properties: {} };
      plaintext.integration.properties = { ...plaintext.integration.properties, ...values };
      plaintext.name = label;
    } else {
      const sites = trustedOriginsForIntegration(integrationId);
      if (['custom', 'azure-openai'].includes(integrationId) && (values.base_url || values.resource_url)) {
        try {
          const baseUrl = new URL(values.base_url || values.resource_url);
          const hostname = baseUrl.hostname.toLowerCase();
          const azureHost = integrationId !== 'azure-openai' || ['.openai.azure.com', '.services.ai.azure.com', '.cognitiveservices.azure.com'].some(suffix => hostname.endsWith(suffix));
          if (baseUrl.protocol === 'https:' && hostname && azureHost) sites.push(hostname);
        } catch { /* invalid base URLs are rejected when used; never grant a site here */ }
      }
      if (integrationId === 'vertex-ai' && values.region) {
        const region = values.region.toLowerCase();
        if (/^[a-z]+-[a-z]+\d$/.test(region)) sites.push(`${ region }-aiplatform.googleapis.com`);
      }
      const policy = {
        mode: 'agents' as const, level: 'autofill' as const, agents: [], sites: [...new Set(sites)],
        expiresAt: null, askFirst: false, allowServerAgents: false,
      };
      plaintext = {
        type: 'apiKey', name: label, agentPolicy: policy,
        integration: { integrationId, accountId, properties: values },
      };
    }
    const encrypted = await this.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
    await this.runSecurityOperation(() => this.runTransaction(async client => {
      this.requireGeneration(generation);
      if (existing.rowCount) {
        const row = existing.rows[0];
        const updated = await this.itemRepository.updateIntegrationCiphertextIfRevision([encrypted.ciphertext, encrypted.encryptedItemKey, itemId, row.revision], client);
        if (!updated.rowCount) throw new LocalVaultError('invalid_operation', 409, 'Vault item changed; retry');
      } else {
        await this.itemRepository.insertIntegrationAccount([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, plaintext.agentPolicy, integrationRef], client);
      }
      if (input.active !== false) {
        await this.integrationStateRepository.upsertImported(keys.userId, integrationId, accountId, client);
      }
      await this.auditHumanAction(client, keys.userId, existing.rowCount ? 'integration_account_updated' : 'integration_account_created', itemId, label);
    }));
    this.requireGeneration(generation);
    return this.readIntegrationMetadata(integrationId, accountId);
  }

  /**
   * Adopt tokens returned by Desktop's fixed-host Sulla Cloud authentication
   * flow. This deliberately uses the Desktop approval identity rather than
   * the general tools broker identity, and never returns secret material.
   */
  async adoptSullaCloudSession(
    callerId: string, token: string | undefined, input: SullaCloudSessionAdoptRequest,
  ): Promise<SullaCloudSessionResponse> {
    this.requireDesktopIdentity(callerId, token);
    const keys = this.requireKeys();
    const generation = this.generation;
    const identifier = /^[A-Za-z0-9._:@-]{1,200}$/;
    if (!input || !identifier.test(input.userId) || !identifier.test(input.activeContractorId) ||
        typeof input.accessToken !== 'string' || !input.accessToken || Buffer.byteLength(input.accessToken) > MAX_CREDENTIAL_BYTES ||
        typeof input.refreshToken !== 'string' || !input.refreshToken || Buffer.byteLength(input.refreshToken) > MAX_CREDENTIAL_BYTES ||
        !Array.isArray(input.contractors) || input.contractors.length > 100) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud session is invalid');
    }
    // The token is received only from the hard-coded Sulla Cloud HTTPS origin.
    // Bind the handoff to that authenticated identity and reject opaque,
    // expired, unsigned, or differently-subjected JWTs.
    let claims: Record<string, unknown>;
    try {
      const parts = input.accessToken.split('.');
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('malformed');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      if (header.alg === 'none' || typeof header.alg !== 'string') throw new Error('unsigned');
    } catch {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud access token is invalid');
    }
    const subjects = [claims.sub, claims.userId, claims.user_id, claims.contractorId, claims.contractor_id]
      .filter((value): value is string => typeof value === 'string');
    if (!subjects.includes(input.userId) && !subjects.includes(input.activeContractorId)) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud token subject does not match the session');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud access token is expired');
    }
    const contractorIds = input.contractors.map(contractor => contractor?.id);
    if (contractorIds.some(id => typeof id !== 'string' || !identifier.test(id)) ||
        (contractorIds.length > 0 && !contractorIds.includes(input.activeContractorId))) {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud contractor identity is invalid');
    }
    const policy = {
      mode: 'only_me' as const, level: 'metadata' as const, agents: [], sites: [], expiresAt: null,
      askFirst: false, allowServerAgents: false,
    };
    const itemId = randomUUID();
    const plaintext: VaultItemPlaintext = {
      type: 'apiKey', name: 'Sulla Cloud', agentPolicy: policy,
      integration: {
        integrationId: SULLA_CLOUD_INTEGRATION_ID,
        accountId: input.userId,
        properties: {
          access_token: input.accessToken, refresh_token: input.refreshToken,
          user_id: input.userId, active_contractor_id: input.activeContractorId,
          contractors_json: JSON.stringify(input.contractors), connection_status: 'connected',
        },
      },
    };
    const encrypted = await this.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
    await this.runSecurityOperation(() => this.runTransaction(async client => {
      this.requireGeneration(generation);
      await this.itemRepository.softDeleteIntegrationAccounts([keys.userId, SULLA_CLOUD_INTEGRATION_ID], client);
      await this.itemRepository.insertSullaCloudAccount([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy,
          `${ SULLA_CLOUD_INTEGRATION_ID }/${ input.userId }`], client);
      await this.integrationStateRepository.upsertCloud(keys.userId, SULLA_CLOUD_INTEGRATION_ID, input.userId, client);
      await this.auditHumanAction(client, keys.userId, 'sulla_cloud_session_adopted', itemId);
      this.requireGeneration(generation);
    }));
    this.sullaCloudSessions().sessionAdopted();
    this.retryPendingSullaCloudRevocations();
    return { userId: input.userId, activeContractorId: input.activeContractorId };
  }

  /**
   * Sign out: revoke the refresh token on Sulla Cloud with the copy the vault holds (queued durably when offline),
   * then destroy the stored token ciphertext. The token never crosses into Electron.
   */
  async clearSullaCloudSession(callerId: string, token: string | undefined): Promise<{ cleared: number; remoteRevoked: boolean; queued: boolean }> {
    this.requireDesktopIdentity(callerId, token);
    this.requireKeys();
    const result = await this.sullaCloudSessions().signOut();
    return { cleared: 1, remoteRevoked: result.remoteRevoked, queued: result.queued };
  }

  async executeDesktopSullaCloudRequest(
    callerId: string, token: string | undefined, input: SullaCloudDesktopRequest,
  ): Promise<BrokerExecuteResponse> {
    this.requireDesktopIdentity(callerId, token);
    const keys = this.requireKeys();
    const method = String(input?.method ?? '').toUpperCase();
    let target: URL;
    try { target = new URL(input.path, `https://${ SULLA_CLOUD_HOST }`); } catch {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud request path is invalid');
    }
    if (target.origin !== `https://${ SULLA_CLOUD_HOST }` || input.path !== `${ target.pathname }${ target.search }`) {
      throw new LocalVaultError('destination_denied', 403, 'Sulla Cloud request must use an allowlisted relative path');
    }
    if (!allowsSullaCloudDesktopRequest(method, target.pathname)) {
      throw new LocalVaultError('policy_denied', 403, 'Sulla Cloud request path or method is not allowlisted');
    }
    const state = await this.integrationStateRepository.findActive<{ active_account_id: string }>(keys.userId, SULLA_CLOUD_INTEGRATION_ID);
    const accountId = state.rows[0]?.active_account_id;
    if (!accountId) throw new LocalVaultError('credential_field_missing', 404, 'Sulla Cloud session is unavailable; sign in again');
    const request: BrokerExecuteRequest = {
      claims: {
        sub: keys.userId, agent_id: 'sulla-desktop-main', pod_id: 'desktop-main',
        credential_scope: { integration_id: SULLA_CLOUD_INTEGRATION_ID, account_id: accountId },
      },
      operation: 'sulla-cloud.desktop', ref: { integrationId: SULLA_CLOUD_INTEGRATION_ID, accountId },
      url: target.toString(), method, headers: {}, body: input.body, bodyEncoding: input.bodyEncoding,
      injections: [], responseType: input.responseType ?? 'json',
    };
    const { credential, item } = await this.freshSullaCloudAccessToken(request, true);
    const allowedHeaders = new Set(['accept', 'content-type', 'x-sulla-timestamp', 'x-sulla-device-signature', 'x-sulla-support-token']);
    const headers = Object.fromEntries(Object.entries(input.headers ?? {})
      .filter(([name, value]) => allowedHeaders.has(name.toLowerCase()) && typeof value === 'string'));
    headers.authorization = `Bearer ${ credential }`;
    const body = input.bodyEncoding === 'base64' && typeof input.body === 'string' ? Buffer.from(input.body, 'base64') : input.body;
    const pinned = await this.validateTarget(target.toString());
    const result = await this.send(
      pinned, method, headers, body, input.responseType ?? 'json', [credential], this.generation, true,
      target.pathname.endsWith('/bundle') ? MAX_STREAM_BYTES : /^\/files-sync\/v1\/uploads\//.test(target.pathname) ? MAX_FILES_SYNC_UPLOAD_BYTES : MAX_RESPONSE_BYTES,
    );
    await this.audit(request, item, false, null);
    return result;
  }

  private requireDesktopIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.approvalServiceId || !constantEqual(token, this.config.approvalServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Desktop service identity is invalid');
    }
  }

  private requireBrokerIdentity(callerId: string, token: string | undefined): void {
    if (callerId !== this.config.brokerServiceId || !constantEqual(token, this.config.brokerServiceToken)) {
      throw new LocalVaultError('invalid_service_identity', 401, 'Broker service identity is invalid');
    }
  }

  private validateBrokerRequestIdentity(input: BrokerExecuteRequest, callerId: string, token: string | undefined): void {
    this.requireBrokerIdentity(callerId, token);
    const claims = input?.claims;
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!input || typeof input.operation !== 'string' || !/^[a-z][a-z0-9_.:-]{1,79}$/i.test(input.operation) ||
        !claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id) ||
        (claims.org_id !== undefined && !UUID_PATTERN.test(claims.org_id)) ||
        (claims.thread_id !== undefined && !validIdentifier(claims.thread_id)) ||
        (claims.job_id !== undefined && !validIdentifier(claims.job_id)) ||
        (claims.workflow_execution_id !== undefined && !validIdentifier(claims.workflow_execution_id))) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    if (input.operation !== 'item.http' && input.ref?.itemId) {
      throw new LocalVaultError('policy_denied', 403, 'Direct item references are only accepted for item.http');
    }
    const scope = claims.credential_scope;
    if (scope && input.operation !== 'item.http' &&
        (!validIdentifier(scope.integration_id) || !validIdentifier(scope.account_id) || scope.item_id !== undefined)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker integration scope is invalid');
    }
    if (scope && ((scope.integration_id !== undefined && !validIdentifier(scope.integration_id)) ||
        (scope.account_id !== undefined && !validIdentifier(scope.account_id)) ||
        (scope.item_id !== undefined && !UUID_PATTERN.test(scope.item_id)) ||
        (scope.repository !== undefined && !validIdentifier(scope.repository)))) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller scope is invalid');
    }
    const ref = input.ref;
    if (!ref || (ref.integrationId !== undefined && !validIdentifier(ref.integrationId)) ||
        (ref.accountId !== undefined && !validIdentifier(ref.accountId)) ||
        (ref.itemId !== undefined && !UUID_PATTERN.test(ref.itemId)) || !Array.isArray(input.injections)) {
      throw new LocalVaultError('invalid_operation', 400, 'Broker credential reference is invalid');
    }
  }

  async migrateLegacy(callerId: string, token: string | undefined): Promise<LegacyMigrationResponse> {
    return this.runSecurityOperation(() => this.migrateLegacyInternal(callerId, token));
  }

  private async migrateLegacyInternal(callerId: string, token: string | undefined): Promise<LegacyMigrationResponse> {
    this.requireControlIdentity(callerId, token);
    const keys = this.requireKeys();
    const generation = this.generation;
    if (!this.config.legacyDatabaseUrl) {
      this.migrationState = 'unlocked';
      return { batchId: 'not-required', imported: 0, skipped: 0, state: 'unlocked' };
    }

    const legacy = new Pool({ connectionString: this.config.legacyDatabaseUrl, max: 1 });
    legacy.on('error', () => { /* idle client dropped; this one-shot pool is ended below */ });
    let rows: LegacyIntegrationRow[] = [];
    try {
      const client = await legacy.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await this.legacyCredentialRepository.list(client);
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
    const already = await this.migrationRepository.findCommitted<{ id: string; imported_count: number; skipped_count: number }>(sourceFingerprint);
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
      const batch = await this.migrationRepository.start<{ id: string }>(sourceFingerprint, client);
      batchId = batch.rows[0].id;
      let imported = 0;
      let skipped = 0;
      for (const groupRows of groups.values()) {
        this.requireGeneration(generation);
        const { integration_id: integrationId, account_id: accountId } = groupRows[0];
        const existing = await this.itemRepository.findLegacyIntegrationItem([`${ integrationId }/${ accountId }`, keys.userId], client);
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
        const encrypted = await this.sealItem(JSON.stringify(plaintext), keys.userKey, { itemId, ownerId: keys.userId });
        const reopened = await this.openItemText(encrypted, keys.userKey, { itemId, ownerId: keys.userId });
        if (reopened !== JSON.stringify(plaintext)) {
          throw new LocalVaultError('migration_failed', 409, 'Migrated item failed reopen verification');
        }
        await this.itemRepository.insertMigratedLegacyItem([itemId, keys.userId, encrypted.ciphertext, encrypted.encryptedItemKey, policy, `${ integrationId }/${ accountId }`], client);
        for (const row of groupRows) {
          await this.migrationRepository.addRow([row.source_kind, row.value_id, sourceFingerprint, itemId], client);
        }
        imported += groupRows.length;
      }
      this.requireGeneration(generation);
      await this.migrationRepository.commit(batchId, imported, skipped, client);
      await client.query('COMMIT');
      keys.legacyVmk?.fill(0);
      keys.legacyVmk = undefined;
      this.migrationState = 'unlocked';
      return { batchId, imported, skipped, state: 'unlocked' };
    } catch (error) {
      await client.query('ROLLBACK');
      this.migrationState = 'migration_failed';
      if (batchId) {
        await this.migrationRepository.fail(batchId).catch(() => undefined);
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
    this.validateBrokerRequestIdentity(input, serviceId, token);
    try {
      if (input.responseType === 'stream' || input.responseType === 'binary-stream') {
        throw new LocalVaultError('invalid_operation', 400, 'Use execute-stream for streaming operations');
      }
      if (input.responseType === 'base64' && input.operation !== FILES_SYNC_OPERATION && input.operation !== 'provider.audio') {
        throw new LocalVaultError('invalid_operation', 400, 'Binary responses are limited to Files sync');
      }
      if (['oauth.exchange', 'oauth.adopt', 'oauth.refresh', 'oauth.revoke', 'oauth.register'].includes(input.operation)) {
        return await this.executeOAuthMutation(input, serviceId, token);
      }
      if (AgentMailboxCloudLane.handles(input.operation)) return await this.agentMailboxes().execute(input);
      const prepared = await this.prepareBrokerRequest(input, serviceId, token);
      const result = await this.send(
        prepared.target, input.method, prepared.headers, prepared.body,
        input.responseType ?? 'json', prepared.secrets, prepared.generation, true, prepared.maxRequestBytes,
        brokerTransferLimits(input.operation).response, input.operation, input.ref.integrationId,
      );
      if (prepared.item) await this.audit(input, prepared.item, false, null);
      return result;
    } catch (error) {
      if (error instanceof LocalVaultError) await this.auditBrokerDenial(input, error.code === 'invalid_upstream_response' ? `${ error.code }: ${ error.message }` : error.code);
      throw error;
    }
  }

  async listBrokerItems(
    claims: BrokerExecuteRequest['claims'], serviceId: string, token: string | undefined,
  ): Promise<BrokerItemListResponse> {
    this.requireBrokerIdentity(serviceId, token);
    const validIdentifier = (value: unknown) => typeof value === 'string' && BROKER_IDENTIFIER_PATTERN.test(value);
    if (!claims || !UUID_PATTERN.test(claims.sub) || !validIdentifier(claims.agent_id) || !validIdentifier(claims.pod_id)) {
      throw new LocalVaultError('invalid_caller_identity', 400, 'Broker caller identity is invalid');
    }
    const keys = this.requireKeys();
    const generation = this.generation;
    if (claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const result = await this.itemRepository.listAgentAccessiblePersonal<ItemRow>([keys.userId]);
    const items: BrokerItemListResponse['items'] = [];
    for (const row of result.rows) {
      const plaintext = JSON.parse(await this.openItemText(
        { version: 1, ciphertext: row.ciphertext, encryptedItemKey: row.encrypted_item_key }, keys.userKey,
        { itemId: row.id, ownerId: keys.userId },
      )) as VaultItemPlaintext;
      const checked = validateVaultItemProxy(plaintext);
      if (!checked.ok) continue;
      const policy = row.agent_policy ?? plaintext.agentPolicy;
      if (!Array.isArray(policy?.sites)) continue;
      const usable = agentPolicyAllows({ ...policy, sites: [] }, {
        agentId: claims.agent_id, level: 'autofill', onServer: false,
      }).allowed;
      if (!usable) continue;
      items.push({
        id: row.id, name: plaintext.name, type: plaintext.type, hosts: checked.proxy.hosts,
        rules: checked.proxy.rules.map(({ target, name, scheme }) => ({ target, name, scheme })),
      });
    }
    this.requireGeneration(generation);
    return { items };
  }

  async createRelay(
    input: BrokerRelayCreateRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<BrokerRelayCreateResponse> {
    this.requireBrokerIdentity(serviceId, token);
    if (input.operation === 'sulla-cloud.relay') return this.createSullaCloudRelay(input);
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
    const plaintext = JSON.parse(await this.openItemText(
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

  /** Agent mail on the owner's Cloud session: path-pinned, vault-refreshed, Bearer injected here only. */
  private agentMailboxes(): AgentMailboxCloudLane {
    this.agentMailboxCloudLane ??= new AgentMailboxCloudLane(SULLA_CLOUD_HOST, {
      activeAccountId: async() => {
        const keys = this.requireKeys();
        const state = await this.integrationStateRepository.findActive<{ active_account_id: string }>(keys.userId, SULLA_CLOUD_INTEGRATION_ID);
        return state.rows[0]?.active_account_id ?? null;
      },
      accessToken: request => this.freshSullaCloudAccessToken(request, true),
    }, {
      send: async(request, target, headers, secrets) => this.send(
        await this.validateTarget(target.toString()), request.method, headers, request.body, 'json', secrets, this.generation, true,
        MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, request.operation, SULLA_CLOUD_INTEGRATION_ID,
      ),
      audit: (request, item) => this.audit(request, item as ItemRow, false, null),
    }, (code, status, message) => new LocalVaultError(code, status, message));
    return this.agentMailboxCloudLane;
  }

  private sullaCloudSessions(): SullaCloudSessionManager {
    this.sullaCloudSessionManager ??= new SullaCloudSessionManagerFactory({
      userKey: () => { const keys = this.requireKeys(); return { userId: keys.userId, userKey: keys.userKey }; },
      generation: () => this.generation,
      requireGeneration: generation => this.requireGeneration(generation),
      transaction: work => this.runSecurityOperation(() => this.runTransaction(work)),
      auditHumanAction: (client, userId, action, itemId) => this.auditHumanAction(client, userId, action, itemId ?? null),
    }, {
      items: this.itemRepository, state: this.integrationStateRepository, revocations: this.revocationRepository,
      serialize: (name, work) => this.withCredentialQueue({ integrationId: SULLA_CLOUD_INTEGRATION_ID, accountId: name }, work),
      postJson: async(url, body) => {
        const result = await this.send(await this.validateTarget(url), 'POST', { 'content-type': 'application/json' }, body, 'json', [body.refreshToken], this.generation, false);
        return { status: result.status, body: result.body };
      },
    }).create();
    return this.sullaCloudSessionManager;
  }

  /** Offline sign-outs queue their revoke; it is retried after unlock and after the next sign-in. Never blocks or throws. */
  private retryPendingSullaCloudRevocations(): void {
    this.sullaCloudSessions().retryPendingRevocations().catch(() => undefined);
  }

  /** Serialize token mutations per integration account (refresh tokens rotate). */
  private async withCredentialQueue<T>(ref: BrokerCredentialRef, operation: () => Promise<T>): Promise<T> {
    const queueKey = `${ ref.integrationId ?? '' }/${ ref.accountId ?? '' }`;
    const previous = this.oauthRefreshQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.oauthRefreshQueues.set(queueKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.oauthRefreshQueues.get(queueKey) === queued) this.oauthRefreshQueues.delete(queueKey);
    }
  }

  private async executeOAuthMutation(input: BrokerExecuteRequest, serviceId: string, token: string | undefined): Promise<BrokerExecuteResponse> {
    return this.withCredentialQueue(input.ref, async() => {
      const prepared = await this.prepareBrokerRequest(input, serviceId, token);
      const result = await this.send(
        prepared.target, input.method, prepared.headers, prepared.body,
        input.responseType === 'text' ? 'text' : 'json', prepared.secrets, prepared.generation, false,
        prepared.maxRequestBytes,
      );
      if (result.status < 200 || result.status >= 300) {
        // Status and the standard OAuth error code (e.g. invalid_grant) only, so the audit says why without copying response text.
        const oauthError = (result.body as { error?: unknown } | null)?.error;
        const code = typeof oauthError === 'string' && /^[a-z_]{1,64}$/.test(oauthError) ? ` ${ oauthError }` : '';
        throw new LocalVaultError('invalid_upstream_response', 502, `OAuth upstream rejected the request (HTTP ${ result.status }${ code })`);
      }
      return await this.runSecurityOperation(() => this.runTransaction(async(client) => {
        this.requireGeneration(prepared.generation);
        if (input.operation === 'oauth.revoke') {
          await this.clearOAuthTokens(prepared, client);
          await this.audit(input, prepared.item!, false, null, client);
          this.requireGeneration(prepared.generation);
          return { ...result, body: { revoked: true } };
        }
        if (input.operation === 'oauth.register') {
          const clientId = await this.storeOAuthRegistration(prepared, result.body, client);
          await this.audit(input, prepared.item!, false, null, client);
          this.requireGeneration(prepared.generation);
          return { ...result, body: { updated: true, operation: 'oauth.register', client_id: clientId } };
        }
        await this.storeOAuthTokens(prepared, result.body, client);
        await this.audit(input, prepared.item!, false, null, client);
        this.requireGeneration(prepared.generation);
        return { ...result, body: this.sanitizeOAuthResult(input.operation, result.body) };
      }));
    });
  }

  private async createSullaCloudRelay(input: BrokerRelayCreateRequest): Promise<BrokerRelayCreateResponse> {
    let params: ReturnType<typeof validateSullaCloudRelayParams>;
    try {
      params = validateSullaCloudRelayParams(input.params);
    } catch {
      throw new LocalVaultError('invalid_operation', 400, 'Sulla Cloud relay parameters are invalid');
    }
    if (input.ref?.integrationId !== SULLA_CLOUD_INTEGRATION_ID) {
      throw new LocalVaultError('policy_denied', 403, 'Relay operation is not registered for this integration');
    }
    const request: BrokerExecuteRequest = {
      claims: input.claims,
      operation: input.operation,
      ref: input.ref,
      url: `https://${ SULLA_CLOUD_HOST }/vault-relay`,
      method: 'GET',
      headers: {},
      body: null,
      injections: [],
      approvalId: input.approvalId,
      responseType: 'json',
    };
    const generation = this.generation;
    const trustedDesktopRelay = input.claims.agent_id === 'sulla' && input.claims.pod_id === 'desktop-relay';
    const { credential, item } = await this.freshSullaCloudAccessToken(request, trustedDesktopRelay);
    let targetUrl: string;
    try {
      targetUrl = sullaCloudRelayUrl(params, credential).toString();
    } catch {
      throw new LocalVaultError('policy_denied', 403, 'Relay room does not match the signed-in Sulla Cloud account');
    }
    const relayId = createRelayId();
    const controller = new AbortController();
    this.relaySessions.set(relayId, { generation, controller });
    try {
      const handle = await this.relayManager.open({
        relayId, operation: input.operation, credential, targetUrl, abortSignal: controller.signal,
      });
      this.requireGeneration(generation);
      await this.audit(request, item, false, null);
      return handle;
    } catch (error) {
      controller.abort(error);
      this.relaySessions.delete(relayId);
      this.relayManager.close(relayId, 'open_failed');
      if (error instanceof LocalVaultError) throw error;
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'relay_unauthorized') {
        throw new LocalVaultError('upstream_failed', 401, 'Sulla Cloud rejected the relay session; sign in again');
      }
      throw new LocalVaultError('upstream_failed', 502, 'Sulla Cloud relay is unreachable');
    }
  }

  /** Returns a usable access token, refreshing (and persisting the rotation) inside the vault. */
  private async freshSullaCloudAccessToken(request: BrokerExecuteRequest, trustedDesktopPath = false): Promise<{ credential: string; item: ItemRow }> {
    const keys = this.requireKeys();
    const generation = this.generation;
    if (request.claims.sub !== keys.userId) throw new LocalVaultError('invalid_caller_identity', 403, 'Broker principal is not unlocked');
    const item = await this.loadBrokerItem(request, SULLA_CLOUD_HOST, trustedDesktopPath);
    const plaintext = JSON.parse(await this.openItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    const policy = item.agent_policy ?? plaintext.agentPolicy;
    if (policy.askFirst) {
      const digest = operationDigest(request);
      const approval = request.approvalId ? this.approvals.get(request.approvalId) : undefined;
      if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
        if (request.approvalId) this.approvals.delete(request.approvalId);
        this.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
        throw new LocalVaultError('approval_required', 428, digest);
      }
      this.approvals.delete(request.approvalId!);
    }
    // Refresh-ahead, single-flight and compare-and-set live in ClientSessionService over the vault item.
    let credential: string | null;
    try {
      credential = await this.sullaCloudSessions().accessToken();
    } catch (error) {
      if (error instanceof LocalVaultError) throw error;
      if (error instanceof IdentityError && error.identityCode === 'refresh_transient') {
        throw new LocalVaultError('upstream_failed', 502, 'Sulla Cloud token refresh failed');
      }
      throw new LocalVaultError('invalid_upstream_response', 502, 'Sulla Cloud token refresh response is invalid');
    }
    this.requireGeneration(generation);
    if (!credential) throw new LocalVaultError('upstream_failed', 401, 'Sulla Cloud session expired; sign in again');
    return { credential, item };
  }

  async executeStream(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
    sink: BrokerStreamSink,
  ): Promise<void> {
    this.validateBrokerRequestIdentity(input, serviceId, token);
    const streamInput = {
      ...input,
      responseType: input.responseType === 'binary-stream' ? 'binary-stream' as const : 'stream' as const,
    };
    try {
      const prepared = await this.prepareBrokerRequest(streamInput, serviceId, token);
      await this.sendStream(prepared, streamInput, sink);
      if (prepared.item) await this.audit(streamInput, prepared.item, false, null);
    } catch (error) {
      if (error instanceof LocalVaultError) {
        // invalid_upstream_response covers two distinct sendStream checks (compressed
        // encoding, non-textual content-type); fold in the observed header values so
        // audit_log says which one actually fired instead of just the shared code.
        const reason = error.code === 'invalid_upstream_response' ? `${ error.code }: ${ error.message }` : error.code;
        await this.auditBrokerDenial(streamInput, reason);
      }
      throw error;
    }
  }

  private async prepareBrokerRequest(
    input: BrokerExecuteRequest,
    serviceId: string,
    token: string | undefined,
  ): Promise<PreparedBrokerRequest> {
    this.validateBrokerRequestIdentity(input, serviceId, token);
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
    const plaintext = JSON.parse(await this.openItemText(
      { version: 1, ciphertext: item.ciphertext, encryptedItemKey: item.encrypted_item_key },
      keys.userKey,
      { itemId: item.id, ownerId: item.collection_id ?? item.owner_user_id ?? keys.userId },
    )) as VaultItemPlaintext;
    const itemPolicy = item.agent_policy ?? plaintext.agentPolicy;
    if (input.operation === 'item.http') {
      const checked = validateVaultItemProxy(plaintext);
      if (!checked.ok) throw new LocalVaultError('policy_denied', 403, 'Vault item has no valid agent usage rules');
      try { validateItemHttpOperation(input) } catch (error) {
        const reason = error instanceof Error ? error.message : 'policy_denied';
        throw new LocalVaultError(reason === 'method_denied' ? 'method_denied' : 'invalid_injection', 403,
          reason === 'injection_denied' ? 'Caller-supplied injections are not allowed for item requests' : 'Item request is not allowed');
      }
      if (!checked.proxy.hosts.some(host => proxyHostMatches(target.hostname.toLowerCase(), host))) {
        throw new LocalVaultError('destination_denied', 403, `Vault item is not allowed on ${ target.hostname }`);
      }
      const decision = agentPolicyAllows(itemPolicy, {
        agentId: input.claims.agent_id, level: 'autofill', host: target.hostname, onServer: false,
      });
      if (!decision.allowed) throw new LocalVaultError('policy_denied', 403, decision.reason ?? 'Credential policy denied the operation');
      const digest = operationDigest(input);
      if (itemPolicy.askFirst) {
        const approval = input.approvalId ? this.approvals.get(input.approvalId) : undefined;
        if (!approval || approval.expiresAt <= Date.now() || approval.digest !== digest) {
          if (input.approvalId) this.approvals.delete(input.approvalId);
          this.pendingApprovals.set(digest, Date.now() + APPROVAL_TTL_MS);
          throw new LocalVaultError('approval_required', 428, digest);
        }
        this.approvals.delete(input.approvalId!);
      }
      const ruleHeaderNames = new Set(checked.proxy.rules.map(rule => rule.name.toLowerCase()));
      ruleHeaderNames.add('authorization');
      const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => !ruleHeaderNames.has(name.toLowerCase())));
      headers['accept-encoding'] = 'identity';
      const secrets: string[] = [];
      const rememberSecret = (value: string) => {
        secrets.push(value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2));
      };
      for (const rule of checked.proxy.rules) {
        let value: string | undefined;
        if (rule.scheme === 'Basic') {
          if (typeof plaintext.username !== 'string' || typeof plaintext.password !== 'string') {
            throw new LocalVaultError('credential_field_missing', 404, 'Basic auth requires username and password');
          }
          if (Buffer.byteLength(plaintext.username) + Buffer.byteLength(plaintext.password) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
          value = `Basic ${ Buffer.from(`${ plaintext.username }:${ plaintext.password }`).toString('base64') }`;
          rememberSecret(plaintext.username);
          rememberSecret(plaintext.password);
          rememberSecret(Buffer.from(`${ plaintext.username }:${ plaintext.password }`).toString('base64'));
        } else {
          const source = proxySource(plaintext, rule.source);
          if (typeof source !== 'string') throw new LocalVaultError('credential_field_missing', 404, 'Agent usage source is unavailable');
          if (Buffer.byteLength(source) > MAX_CREDENTIAL_BYTES) throw new LocalVaultError('policy_denied', 403, 'Credential field exceeds the broker limit');
          value = rule.scheme === 'raw' ? source : `${ rule.scheme } ${ source }`;
          rememberSecret(source);
        }
        if (rule.target === 'header' && /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new LocalVaultError('policy_denied', 403, 'Agent usage value is not a valid HTTP header');
        rememberSecret(value);
        if (rule.target === 'header') headers[rule.name] = value;
        else target.searchParams.set(rule.name, value);
      }
      this.requireGeneration(generation);
      return { target, headers, body: input.body, secrets, generation, maxRequestBytes: MAX_RESPONSE_BYTES, item, plaintext };
    }
    let effectivePolicy = itemPolicy;
    if (input.operation.startsWith('oauth.')) {
      try {
        await validateOAuthDestination(this.db, input, plaintext);
        effectivePolicy = { ...itemPolicy, sites: [target.hostname] };
      } catch {
        throw new LocalVaultError('destination_denied', 403, 'OAuth destination is not registered for this provider');
      }
    }
    // The Files service acts for the owner on their own Cloud account, so the
    // owner-only agent policy doesn't apply; its operation policy still does.
    const decision: { allowed: boolean; reason?: string } = isTrustedFilesCloudCall(input) ? { allowed: true } : agentPolicyAllows(effectivePolicy, {
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

    deriveChatgptAccountRoutingForRequest(input, plaintext);

    const secrets: string[] = [];
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    headers['accept-encoding'] = 'identity';
    let body: unknown = input.bodyEncoding === 'base64' && typeof input.body === 'string'
      ? Buffer.from(input.body, 'base64')
      : input.body;
    for (const injection of input.injections) {
      const value = credentialField(plaintext, injection.field) ??
        (input.operation.startsWith('sulla-cloud.') && injection.field === 'api_token'
          ? credentialField(plaintext, 'access_token')
          : undefined);
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
          : typeof body === 'string' ? new URLSearchParams(body) : formFromObject(body);
        form.set(injection.name, injected);
        body = form;
        setContentType(headers, 'application/x-www-form-urlencoded');
      } else {
        body = applyJsonPath(body, injection.name, injected);
      }
    }
    // Public OAuth clients (PKCE, no secret) get no form injection, so an object body declared as a
    // form would otherwise go out as JSON; token endpoints like auth.x.ai reject that with a 415.
    const declaredType = headerValue(headers, 'content-type');
    if (declaredType && /^application\/x-www-form-urlencoded\b/i.test(declaredType) &&
        body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
      body = formFromObject(body);
      setContentType(headers, 'application/x-www-form-urlencoded');
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
    if (input.operation === 'oauth.register') setContentType(headers, 'application/json');
    this.requireGeneration(generation);
    return {
      target,
      headers,
      body,
      secrets,
      generation,
      maxRequestBytes: brokerTransferLimits(input.operation).request,
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

  private requireStableGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new LocalVaultError('vault_locked', 423, 'Vault state changed during request');
    }
  }

  private runSecurityOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.securityOperationTail;
    let release!: () => void;
    this.securityOperationTail = new Promise<void>(resolve => { release = resolve; });
    return (async() => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }

  private async auditHumanAction(db: Queryable, actorId: string, action: string, itemId: string | null = null, path?: string): Promise<void> {
    await this.auditLogRepository.recordHumanAction([actorId, itemId, action], db);
    if (itemId) this.filesAudit.emit({ subjectKind: 'vault-secret', subjectId: itemId, action, actor: actorId, result: 'allowed', ...(path ? { path } : {}) });
  }

  private async runTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async validateTarget(raw: string): Promise<URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses: PinnedAddress[] }> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new LocalVaultError('invalid_destination', 400, 'Destination URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new LocalVaultError('invalid_destination', 403, 'Destination must be HTTPS without credentials or fragments');
    }
    const pinnedAddresses = await this.resolvePinnedAddresses(url.hostname);
    return Object.assign(url, {
      pinnedAddress: pinnedAddresses[0].address,
      pinnedFamily: pinnedAddresses[0].family,
      pinnedAddresses,
    });
  }

  /**
   * Resolve and validate public addresses. Called per request (and again for
   * a connect retry); nothing is cached across requests, so a network change
   * never leaves a stale pin behind.
   */
  private async resolvePinnedAddresses(hostname: string, attempt = 1): Promise<PinnedAddress[]> {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      const detail = describeUpstreamError(error);
      const willRetry = detail.code === 'EAI_AGAIN' && attempt < UPSTREAM_MAX_ATTEMPTS;
      console.warn(formatUpstreamFailureLog({
        operation: 'dns.lookup', hostname, attempt, maxAttempts: UPSTREAM_MAX_ATTEMPTS, phase: 'dns', detail,
        families: 'none', reusedSocket: false, willRetry,
      }));
      if (willRetry) {
        await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAYS_MS[attempt - 1]));
        return this.resolvePinnedAddresses(hostname, attempt + 1);
      }
      throw new LocalVaultError('upstream_failed', 502, 'Broker upstream DNS lookup failed', upstreamFailureReason('dns', detail.code));
    }
    if (!addresses.length || addresses.some(candidate => privateAddress(candidate.address))) {
      throw new LocalVaultError('destination_denied', 403, 'Destination resolved to a private, local, or invalid address');
    }
    return addresses.map(candidate => ({ address: candidate.address, family: candidate.family as 4 | 6 }));
  }

  /**
   * Open one upstream HTTPS request with connect-phase self-healing.
   *
   * A failure before the TLS handshake completes on a fresh socket means no
   * request bytes reached the upstream, so it is safe to re-resolve DNS and
   * try twice more (other address family first). Reused keep-alive sockets and
   * failures after the handshake are never retried. Every failure is logged
   * with its errno/syscall/family and surfaces a non-secret reason code.
   */
  private openUpstream(
    target: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] },
    options: {
      operation:  string;
      method:     string;
      headers:    Record<string, string>;
      timeoutMs:  number;
      payload?:   Buffer;
      generation: number;
      failureMessage: string;
      timeoutError: () => LocalVaultError;
    },
    hooks: {
      onRequest(request: ClientRequest): void;
      onResponse(request: ClientRequest, response: IncomingMessage): void;
      onError(request: ClientRequest, error: LocalVaultError): void;
      canRetry?(): boolean;
    },
  ): void {
    const maxAttempts = UPSTREAM_MAX_ATTEMPTS;
    const start = (addresses: PinnedAddress[], attempt: number) => {
      let connected = false;
      let reusedSocket = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = () => { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined };
      this.requireGeneration(options.generation);
      // Family-autoselection fields are honoured by net.connect but missing from http's option types.
      const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean; autoSelectFamilyAttemptTimeout?: number } = {
        protocol: 'https:',
        hostname: target.hostname,
        servername: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${ target.pathname }${ target.search }`,
        method: options.method,
        headers: options.headers,
        timeout: options.timeoutMs,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: attempt === 1 ? UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS : UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS,
        lookup: addresses.length ? pinnedAddressesLookup(addresses) : pinnedLookup(target.pinnedAddress, target.pinnedFamily),
      };
      const request = https.request(requestOptions, response => hooks.onResponse(request, response));
      this.inFlight.add(request);
      hooks.onRequest(request);
      request.on('socket', socket => {
        if (request.reusedSocket) {
          connected = true;
          reusedSocket = true;
          return;
        }
        connectTimer = setTimeout(() => {
          request.destroy(Object.assign(new Error('Upstream connect timed out'), { code: 'UPSTREAM_CONNECT_TIMEOUT', syscall: 'connect' }));
        }, UPSTREAM_CONNECT_TIMEOUT_MS);
        connectTimer.unref?.();
        socket.once('secureConnect', () => { connected = true; clearConnectTimer() });
        socket.once('close', clearConnectTimer);
      });
      request.on('timeout', () => request.destroy(options.timeoutError()));
      request.on('error', error => {
        clearConnectTimer();
        this.inFlight.delete(request);
        if (error instanceof LocalVaultError) {
          hooks.onError(request, error);
          return;
        }
        const detail = describeUpstreamError(error);
        const phase = upstreamFailurePhase(detail.code, connected);
        const reason = upstreamFailureReason(phase, detail.code === 'UPSTREAM_CONNECT_TIMEOUT' ? 'timeout' : detail.code);
        const willRetry = attempt < maxAttempts && isReconnectableUpstreamError(error, connected) && (hooks.canRetry?.() ?? true);
        console.warn(formatUpstreamFailureLog({
          operation: options.operation, hostname: target.hostname, attempt, maxAttempts, phase, detail,
          families: familySummary(addresses), reusedSocket, willRetry,
        }));
        const failure = new LocalVaultError('upstream_failed', 502, options.failureMessage, reason);
        if (!willRetry) {
          hooks.onError(request, failure);
          return;
        }
        this.resolvePinnedAddresses(target.hostname).then(fresh => {
          if (!(hooks.canRetry?.() ?? true)) {
            hooks.onError(request, failure);
            return;
          }
          const retryAddresses = retryAddressOrder(fresh, detail.attempts.length ? detail.attempts : addresses.map(candidate => `v${ candidate.family }:${ detail.code }`));
          setTimeout(() => {
            if (!(hooks.canRetry?.() ?? true)) {
              hooks.onError(request, failure);
              return;
            }
            try {
              start(retryAddresses, attempt + 1);
            } catch (retryError) {
              hooks.onError(request, retryError instanceof LocalVaultError ? retryError : failure);
            }
          }, UPSTREAM_RETRY_DELAYS_MS[attempt - 1]);
        }).catch(resolveError => {
          hooks.onError(request, resolveError instanceof LocalVaultError ? resolveError : failure);
        });
      });
      if (options.payload) request.write(options.payload);
      request.end();
    };
    start(target.pinnedAddresses?.length ? [...target.pinnedAddresses] : [], 1);
  }

  private async loadBrokerItem(input: BrokerExecuteRequest, host: string | null, bypassAgentPolicy = false): Promise<ItemRow> {
    const ref = input.ref ?? {};
    const scope = input.claims.credential_scope;
    if (input.operation === 'item.http') {
      if (!scope?.item_id || !ref.itemId || scope.item_id !== ref.itemId || scope.integration_id || scope.account_id || ref.integrationId || ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Vault item reference is outside the signed caller scope');
      }
    } else {
      if (!scope || !ref.integrationId || !ref.accountId ||
          scope.integration_id !== ref.integrationId || scope.account_id !== ref.accountId) {
        throw new LocalVaultError('policy_denied', 403, 'Credential reference is outside the signed caller scope');
      }
      if (ref.itemId) throw new LocalVaultError('policy_denied', 403, 'Direct item references are not accepted by the local broker');
    }
    if (input.operation === 'github.git') {
      const path = new URL(input.url).pathname;
      const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      const repository = match ? `${ match[1] }/${ match[2] }`.toLowerCase() : '';
      if (!scope.repository || repository !== scope.repository.replace(/\.git$/i, '').toLowerCase()) {
        throw new LocalVaultError('policy_denied', 403, 'Git repository is outside the signed caller scope');
      }
    }
    const integrationRef = ref.integrationId ? `${ ref.integrationId }/${ ref.accountId ?? 'default' }` : null;
    const result = await this.itemRepository.findBrokerCredential<ItemRow>([input.claims.sub, ref.itemId ?? null, integrationRef]);
    const item = result.rows[0];
    const personal = item?.owner_user_id === input.claims.sub;
    // Local authority has only the personal user key in memory. It must never
    // attempt to decrypt a collection item with that key; collection-key
    // custody remains a separate server-mode path until explicitly supported.
    if (!item || !personal || item.collection_id) {
      throw new LocalVaultError('policy_denied', 403, 'Credential is unavailable to this caller');
    }
    const trustedFirstParty = bypassAgentPolicy || isTrustedFilesCloudCall(input);
    if (host && input.operation !== 'item.http' && !trustedFirstParty) {
      const siteDecision = agentPolicyAllows(item.agent_policy, { agentId: input.claims.agent_id, level: 'autofill', host, onServer: false });
      if (!siteDecision.allowed) {
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
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'x-sulla-git-request-id']);
    const headers = Object.fromEntries(Object.entries(prepared.headers).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    const streamLimit = input.operation === 'github.git' ? MAX_GIT_STREAM_BYTES : MAX_STREAM_BYTES;
    let payload: Buffer | undefined;
    if (prepared.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = serializeBrokerBody(prepared.body);
      if (payload.byteLength > streamLimit) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
    }
    const binary = input.responseType === 'binary-stream';
    const redactor = binary ? null : new StreamingRedactor(prepared.secrets);
    const requestedId = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-sulla-git-request-id')?.[1];
    const requestId = typeof requestedId === 'string' && /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : randomUUID();
    const startedAt = Date.now();
    let received = 0;
    let logged = false;
    let endedBy = 'unknown';
    let terminalReason: unknown;
    const target = new URL(prepared.target);
    const pathParts = target.pathname.split('/').filter(Boolean);
    const repository = target.hostname === 'github.com' && pathParts.length >= 2 ? `${ pathParts[0] }/${ pathParts[1].replace(/\.git$/, '') }` : 'unknown';
    const service = input.operation === 'github.git' ? (target.pathname.includes('git-receive-pack') ? 'receive-pack' : 'upload-pack') : input.operation;
    const logTermination = () => {
      if (logged) return;
      logged = true;
      const error = terminalReason instanceof Error ? { name: terminalReason.name, code: (terminalReason as NodeJS.ErrnoException).code, message: prepared.secrets.reduce((message, secret) => secret ? message.split(secret).join('[secret redacted]') : message, terminalReason.message) } : terminalReason;
      console.info(JSON.stringify({ component: 'vault.broker.stream', requestId, repository, service, startedAt: new Date(startedAt).toISOString(), bytesReceived: received, durationMs: Date.now() - startedAt, endedBy, ...(error ? { reason: error } : {}) }));
    };
    if (binary) console.info(JSON.stringify({ component: 'vault.broker.stream', requestId, repository, service, startedAt: new Date(startedAt).toISOString(), event: 'start' }));

    await new Promise<void>((resolve, reject) => {
      let started = false;
      let aborted = false;
      let current: ClientRequest | undefined;
      sink.onAbort(() => {
        aborted = true;
        endedBy = 'downstream-abort';
        terminalReason = 'broker client disconnected';
        current?.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected'));
      });
      this.openUpstream(prepared.target, {
        operation: input.operation,
        method,
        headers,
        timeoutMs: 120_000,
        payload,
        generation: prepared.generation,
        failureMessage: 'Broker upstream stream failed',
        timeoutError: () => new LocalVaultError('upstream_timeout', 504, 'Broker stream timed out'),
      }, {
        canRetry: () => !aborted && !started,
        onRequest: request => {
          current = request;
          if (aborted) request.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected'));
        },
        onError: (_request, safe) => {
          if (endedBy === 'unknown') endedBy = safe instanceof Error && /timed out/i.test(safe.message) ? 'vault-timeout' : 'upstream-error';
          terminalReason = safe;
          if (started) {
            sink.destroy(safe);
            logTermination();
            resolve();
          } else {
            logTermination();
            reject(safe);
          }
        },
        onResponse: (request, response) => {
          if (prepared.generation !== this.generation) {
            response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
            return;
          }
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (typeof location === 'string' && this.brokerRedirectPolicy.allowsGitHubLogRedirect({
              operation: input.operation, integrationId: input.ref.integrationId, requestUrl: prepared.target,
              status: response.statusCode, location,
            })) {
              response.resume();
              started = true;
              sink.start(302, { location });
              this.inFlight.delete(request);
              sink.end();
              endedBy = 'upstream-redirect';
              logTermination();
              resolve();
              return;
            }
            response.resume();
            request.destroy(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
            return;
          }
          const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
          const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (contentEncoding && contentEncoding !== 'identity') {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, `Compressed broker streams are not accepted (content-encoding: ${ contentEncoding })`));
            return;
          }
          const bodyless = streamResponseIsBodyless(method, response.statusCode ?? 0, response.headers['content-length']);
          // Untyped bodies still pass through the redactor; providers (chatgpt.com)
          // send untyped error replies, and blocking them hid the real status.
          if (!binary && !bodyless && contentType && !contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('event-stream') && !contentType.includes('ndjson')) {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, `Streaming adapter requires a textual upstream response (status: ${ response.statusCode ?? 'none' }, content-type: ${ contentType })`));
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
            if (received > streamLimit) {
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
            try { this.requireGeneration(prepared.generation); } catch (error) { endedBy = 'vault-generation-change'; terminalReason = error; request.destroy(error as Error); return; }
            const tail = redactor?.flush();
            if (tail?.byteLength) sink.write(tail);
            this.inFlight.delete(request);
            sink.end();
            endedBy = 'upstream-end';
            logTermination();
            resolve();
          });
          response.on('error', error => { endedBy = 'upstream-response-error'; terminalReason = error; request.destroy(error); });
        },
      });
    });
  }

  private async send(
    url: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] },
    methodInput: string,
    headersInput: Record<string, string>,
    bodyInput: unknown,
    responseType: 'json' | 'text' | 'base64',
    secrets: string[],
    generation: number,
    redactResponseBody = true,
    maxRequestBytes = MAX_RESPONSE_BYTES,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    operation = 'broker.request',
    integrationId?: string,
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
      if (!headerValue(headers, 'content-type')) {
        headers['content-type'] = Buffer.isBuffer(bodyInput)
          ? 'application/octet-stream'
          : bodyInput instanceof URLSearchParams ? 'application/x-www-form-urlencoded'
            : typeof bodyInput === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      }
    }

    return new Promise<BrokerExecuteResponse>((resolve, reject) => {
      this.openUpstream(url, {
        operation: 'broker.request',
        method,
        headers,
        timeoutMs: 30_000,
        payload,
        generation,
        failureMessage: 'Broker upstream request failed',
        timeoutError: () => new LocalVaultError('upstream_timeout', 504, 'Broker request timed out'),
      }, {
        onRequest: () => undefined,
        onError: (_request, error) => reject(error),
        onResponse: (request, response) => {
          if (generation !== this.generation) {
            response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
            return;
          }
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (typeof location === 'string' && this.brokerRedirectPolicy.allowsGitHubLogRedirect({
              operation, integrationId, requestUrl: url,
              status: response.statusCode, location,
            })) {
              response.resume();
              this.inFlight.delete(request);
              resolve({ status: 302, headers: { location }, body: '' });
              return;
            }
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
            if (size > maxResponseBytes) request.destroy(new LocalVaultError('response_too_large', 502, 'Broker response exceeded the size limit'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try { this.requireGeneration(generation); } catch (error) { reject(error); return; }
            if (responseType === 'base64') {
              // Binary bodies cannot be redacted in place, so one that echoes a credential is refused outright.
              const bytes = Buffer.concat(chunks);
              if (secrets.some(secret => secret && bytes.includes(Buffer.from(secret)))) {
                reject(new LocalVaultError('invalid_upstream_response', 502, 'Upstream response echoed a credential'));
                return;
              }
              const binaryHeaders: Record<string, string> = {};
              for (const name of ['content-type', 'content-length', 'x-content-sha256']) {
                const value = response.headers[name];
                if (typeof value === 'string') binaryHeaders[name] = value;
              }
              this.inFlight.delete(request);
              resolve({ status: response.statusCode ?? 502, headers: binaryHeaders, body: bytes.toString('base64') });
              return;
            }
            const upstream = Buffer.concat(chunks).toString('utf8');
            const raw = redactResponseBody ? redact(upstream, secrets) : upstream;
            const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key)$/i;
            const outputHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = redact(value, secrets);
            }
            let body: unknown = raw;
            if (responseType === 'json' && raw) {
              // Error responses are often plain text; keep them so the caller sees the real HTTP status.
              const ok = (response.statusCode ?? 502) >= 200 && (response.statusCode ?? 502) < 300;
              try { body = JSON.parse(raw); } catch {
                if (ok) { reject(new LocalVaultError('invalid_upstream_response', 502, 'Expected a JSON response')); return; }
              }
            }
            this.inFlight.delete(request);
            resolve({ status: response.statusCode ?? 502, headers: outputHeaders, body });
          });
        },
      });
    });
  }

  private async storeOAuthTokens(prepared: PreparedBrokerRequest, body: unknown, db: Queryable): Promise<void> {
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
    const chatgptAccountId = extractBoundedChatgptAccountId(response.id_token, response.access_token);
    if (chatgptAccountId) integration.properties.chatgpt_account_id = chatgptAccountId;
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
  }

  private async storeOAuthRegistration(prepared: PreparedBrokerRequest, body: unknown, db: Queryable): Promise<string> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response is invalid');
    }
    const response = body as Record<string, unknown>;
    if (typeof response.client_id !== 'string' || response.client_id.length < 1 || response.client_id.length > 4096) {
      throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response did not contain a valid client identity');
    }
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    prepared.plaintext.integration.properties.oauth_client_id = response.client_id;
    for (const field of ['client_secret', 'registration_access_token'] as const) {
      const value = response[field];
      if (value !== undefined && (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES)) {
        throw new LocalVaultError('invalid_upstream_response', 502, 'OAuth registration response contained invalid secret material');
      }
      if (typeof value === 'string') prepared.plaintext.integration.properties[field] = value;
    }
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
    return response.client_id;
  }

  private async clearOAuthTokens(prepared: PreparedBrokerRequest, db: Queryable): Promise<void> {
    const keys = this.requireKeys();
    this.requireGeneration(prepared.generation);
    if (!prepared.item || !prepared.plaintext?.integration) {
      throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    }
    for (const field of ['access_token', 'refresh_token', 'id_token', 'chatgpt_account_id', 'expires_in', 'expires_at', 'scope', 'token_type']) {
      delete prepared.plaintext.integration.properties[field];
    }
    prepared.item.revision = await this.persistOAuthItem(prepared, keys, db);
  }

  private async persistOAuthItem(
    prepared: Pick<PreparedBrokerRequest, 'item' | 'plaintext' | 'generation'>, keys: UnlockedKeys,
    db: Queryable,
  ): Promise<number> {
    if (!prepared.item || !prepared.plaintext) throw new LocalVaultError('migration_failed', 409, 'OAuth credential item is unavailable');
    const ownerId = prepared.item.collection_id ?? prepared.item.owner_user_id ?? keys.userId;
    const encrypted = await this.sealItem(JSON.stringify(prepared.plaintext), keys.userKey, {
      itemId: prepared.item.id,
      ownerId,
    });
    this.requireGeneration(prepared.generation);
    const updated = await this.itemRepository.updateOAuthCiphertextIfRevision([encrypted.ciphertext, encrypted.encryptedItemKey, prepared.item.id, prepared.item.revision], db);
    if (!updated.rowCount) throw new LocalVaultError('migration_failed', 409, 'OAuth item changed during token update');
    this.requireGeneration(prepared.generation);
    return Number(updated.rows[0].revision);
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

  private async audit(
    input: BrokerExecuteRequest,
    item: ItemRow,
    blocked: boolean,
    reason: string | null,
    db: Queryable = this.db,
  ): Promise<void> {
    await this.auditLogRepository.recordOutboundRequest([input.claims.sub, item.org_id ?? null, item.collection_id, item.id, input.claims.pod_id,
        { agentId: input.claims.agent_id, operation: input.operation,
          destination: input.operation === 'item.http' ? new URL(input.url).hostname : new URL(input.url).origin,
          ...(input.operation === 'item.http' ? { itemId: item.id } : {}) }, blocked, reason], db);
    this.filesAudit.emit({ subjectKind: 'vault-secret', subjectId: item.id, action: 'vault_outbound_request', actor: input.claims.agent_id || input.claims.sub, result: blocked ? 'blocked' : 'allowed', meta: { operation: input.operation, agentId: input.claims.agent_id } });
  }

  private async auditBrokerDenial(input: BrokerExecuteRequest, reason: string): Promise<void> {
    let destination: string | undefined;
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') destination = input.operation === 'item.http' ? parsed.hostname : parsed.origin;
    } catch {
      // Invalid destinations are represented by the denial reason, never copied into audit metadata.
    }
    await this.auditLogRepository.recordOutboundDenial([input.claims.sub, input.claims.pod_id, {
        agentId: input.claims.agent_id,
        operation: input.operation,
        ...(input.operation === 'item.http' && UUID_PATTERN.test(input.ref?.itemId ?? '') ? { itemId: input.ref.itemId } : {}),
        ...(destination ? { destination } : {}),
      }, reason]);
  }
}


