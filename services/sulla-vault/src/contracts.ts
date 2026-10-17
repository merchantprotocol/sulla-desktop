/**
 * Wire contract shared by the local Desktop vault service and trusted callers.
 * Local-mode responses never contain credential plaintext, wrapped item keys,
 * user keys, private keys, master material, or refresh tokens.
 */
export type LocalVaultState = 'locked' | 'unlocked' | 'migration_required' | 'migration_failed';

export type LocalVaultErrorCode =
  | 'vault_locked'
  | 'vault_unavailable'
  | 'migration_required'
  | 'migration_failed'
  | 'invalid_service_identity'
  | 'invalid_caller_identity'
  | 'invalid_bootstrap_challenge'
  | 'invalid_unlock_material'
  | 'invalid_credentials'
  | 'invalid_human_session'
  | 'invalid_csrf'
  | 'approval_required'
  | 'approval_not_pending'
  | 'policy_denied'
  | 'credential_field_missing'
  | 'invalid_operation'
  | 'invalid_destination'
  | 'destination_denied'
  | 'invalid_injection'
  | 'method_denied'
  | 'redirect_denied'
  | 'request_too_large'
  | 'response_too_large'
  | 'invalid_upstream_response'
  | 'upstream_failed'
  | 'upstream_timeout'
  | 'unsupported_secret_egress';

export interface LocalVaultErrorResponse {
  error:   LocalVaultErrorCode | string;
  message: string;
  /** Present only for approval_required; contains no secret or credential ref. */
  operationId?: string;
}

export interface LocalVaultStatusResponse {
  state:     LocalVaultState;
  unlocked:  boolean;
  /** Present only while unlocked; callers bind capability claims to this UUID. */
  principalId?: string;
  /** True only while a short-lived master-key cache update is waiting for the isolated OS helper. */
  cacheUpdateRequired: boolean;
  migration: { required: boolean; lastBatchId?: string; error?: string };
}

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

export interface HumanSessionResponse {
  url:       string;
  csrf:      string;
  expiresAt: number;
  /** Pre-unlock sessions can only set up, unlock, or recover the vault. */
  phase:     'pre-unlock' | 'unlocked';
}

export interface HumanUnlockRequest { password: string }
export interface HumanLockResponse {
  csrf:      string;
  expiresAt: number;
  phase:     'pre-unlock';
  state:     'locked';
}
export interface HumanUnlockResponse {
  csrf:      string;
  expiresAt: number;
  phase:     'unlocked';
  state:     LocalVaultState;
  /** The isolated bootstrap helper must consume the one-use cache update immediately. */
  cacheMode: 'helper-update-required';
}

export interface HumanPasswordChangeRequest { currentPassword: string; nextPassword: string }
export interface HumanRecoveryConfigureRequest { recoveryCode: string }
export interface HumanRecoveryUnlockRequest { recoveryCode: string; nextPassword: string }
export interface HumanBackupExportRequest { backupPassword: string }
export interface HumanBackupEnvelope {
  version:    1;
  salt:       string;
  parameters: { memoryBytes: number; operations: number };
  envelope:   { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string };
}
export interface HumanBackupImportRequest { backupPassword: string; backup: HumanBackupEnvelope }

export interface BrokerRelayCreateRequest {
  claims:    BrokerClaims;
  operation: 'slack.socket-mode' | 'discord.gateway';
  ref:       BrokerCredentialRef;
}
export interface BrokerRelayCreateResponse { relayId: string; expiresAt: number }
export interface BrokerRelaySendRequest { sequence?: number; type: string; payload: unknown }

export type DesktopControlAction = 'status' | 'lock' | 'migrate' | 'create-human-session';

export interface DesktopControlIdentity {
  serviceId: string;
  token:     string;
}

export interface BrokerClaims {
  sub:                    string;
  agent_id:               string;
  pod_id:                 string;
  org_id?:                string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
  /** Signed by the trusted caller and enforced against ref before lookup. */
  credential_scope?: {
    integration_id: string;
    account_id:     string;
    /** Required for github.git; normalized as owner/repository. */
    repository?:    string;
  };
}

export interface BrokerCredentialRef {
  integrationId?: string;
  accountId?:     string;
  itemId?:        string;
}

export interface BrokerInjection {
  field:   string;
  target:  'header' | 'query' | 'json' | 'form';
  name:    string;
  scheme?: 'Bearer' | 'Basic' | 'BasicClient' | 'Bot' | 'GitHubBasic' | 'Token' | 'raw';
}

export interface BrokerExecuteRequest {
  claims:        BrokerClaims;
  operation:     string;
  ref:           BrokerCredentialRef;
  url:           string;
  method:        string;
  headers?:      Record<string, string>;
  body?:         unknown;
  /** When set, body must be a base64 string decoded only by the typed binary adapter. */
  bodyEncoding?: 'base64';
  injections:    BrokerInjection[];
  approvalId?:   string;
  responseType?: 'json' | 'text' | 'stream' | 'binary-stream';
}

export interface BrokerExecuteResponse {
  status:  number;
  headers: Record<string, string>;
  body:    unknown;
}

export interface BrokerStatusResponse {
  state:        LocalVaultState;
  unlocked:     boolean;
  principalId?: string;
}

/**
 * /v1/broker/execute-stream returns upstream status and sanitized headers as
 * HTTP status/headers, then writes the sanitized body directly. It never wraps
 * the stream in JSON. Before headers, failures use LocalVaultErrorResponse.
 * After headers, timeout, lock, or policy failure terminates the stream.
 */
export interface BrokerStreamResponseMeta {
  status:      number;
  contentType?: string;
}

export interface BrokerApprovalRequest {
  operationId: string;
}

export interface BrokerApprovalResponse {
  approvalId: string;
  expiresAt:  number;
}

export interface LegacyMigrationResponse {
  batchId:  string;
  imported: number;
  skipped:  number;
  state:    LocalVaultState;
}

export interface RotateMasterKeyRequest {
  /** base64url, exactly 32 bytes, delivered only by the authenticated bootstrap helper. */
  nextMasterKey: string;
}

export interface ConfigureRecoveryRequest {
  recoveryCode: string;
}

export interface RecoverVaultRequest {
  callerId:      string;
  challengeId:   string;
  clientProof:   string;
  recoveryCode:  string;
  nextMasterKey: string;
}

