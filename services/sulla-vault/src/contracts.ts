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

export interface HumanSessionResponse {
  url:       string;
  csrf:      string;
  expiresAt: number;
}

export interface BrokerClaims {
  sub:                    string;
  agent_id:               string;
  pod_id:                 string;
  org_id?:                string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
}

export interface BrokerCredentialRef {
  integrationId?: string;
  accountId?:     string;
  itemId?:        string;
}

export interface BrokerInjection {
  field:   string;
  target:  'header' | 'query' | 'json';
  name:    string;
  scheme?: 'Bearer' | 'Basic' | 'Bot' | 'GitHubBasic' | 'Token' | 'raw';
}

export interface BrokerExecuteRequest {
  claims:        BrokerClaims;
  operation:     string;
  ref:           BrokerCredentialRef;
  url:           string;
  method:        string;
  headers?:      Record<string, string>;
  body?:         unknown;
  /** Typed binary request body for smart HTTP adapters; mutually exclusive with body. */
  bodyBase64?:   string;
  injections:    BrokerInjection[];
  approvalId?:   string;
  responseType?: 'json' | 'text' | 'stream' | 'binary-stream';
}

export interface BrokerExecuteResponse {
  status:  number;
  headers: Record<string, string>;
  body:    unknown;
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

