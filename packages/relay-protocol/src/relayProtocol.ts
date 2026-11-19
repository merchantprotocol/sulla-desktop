// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

export interface RelayToolResult {
  success: boolean;
  result?: unknown;
  error?:  { code: string; message: string; details?: unknown };
}

/** Serializable capability claims and request identity carried over the relay. */
export interface RelayToolExecutionContext {
  v:                      1;
  iss:                    string;
  aud:                    'sulla-tools';
  sub:                    string;
  org_id?:                string;
  group_ids?:             string[];
  agent_id?:              string;
  pod_id?:                string;
  thread_id?:             string;
  job_id?:                string;
  workflow_execution_id?: string;
  device_id?:             string;
  credential_scope?:      {
    integration_id: string;
    account_id:     string;
    repository?:    string;
  };
  scopes:                 string[];
  iat:                    number;
  exp:                    number;
  jti:                    string;
  request_id:             string;
}

export interface RelayError {
  code:       'DEVICE_OFFLINE' | 'DEADLINE_EXCEEDED' | 'BACKPRESSURE' | 'FORBIDDEN' | 'BAD_REQUEST' | 'INTERNAL'
    | 'REQUEST_IN_PROGRESS' | 'REQUEST_ID_REUSE' | 'RESULT_TOO_LARGE';
  message:    string;
  retryable?: boolean;
  /** Structured context, e.g. ToolDeadlineDetails on DEADLINE_EXCEEDED. */
  details?:   unknown;
}

interface RelayEnvelopeBase {
  requestId: string;
  deviceId:  string;
}

export interface RelayToolCallEnvelope extends RelayEnvelopeBase {
  type:             'tool-call';
  action?:          'offer' | 'execute' | 'cancel';
  originReplicaId?: string;
  /** Binds retries/results to the authenticated user, capability context and exact payload. */
  requestFingerprint?: string;
  ctx?:             RelayToolExecutionContext;
  category?:        string;
  tool?:            string;
  args?:            unknown;
  /** Remaining budget assigned by the relay on receipt; never compare host clocks. */
  remainingMs?:     number;
  operationTypes?:  string[];
}

export interface RelayToolResultEnvelope extends RelayEnvelopeBase {
  type:             'tool-result';
  originReplicaId?: string;
  requestFingerprint?: string;
  result?:          RelayToolResult;
  error?:           RelayError;
  /** Monotonic per request. A late final result supersedes a provisional timeout. */
  resultRevision?:  number;
  provisional?:     boolean;
  late?:            boolean;
}

export interface RelayToolResultAckEnvelope extends RelayEnvelopeBase {
  type: 'tool-result-ack';
  resultRevision: number;
  requestFingerprint: string;
}

/** Desktop asks the relay to revalidate the original Redis lease after receiving an offer. */
export interface RelayToolCallClaimEnvelope extends RelayEnvelopeBase {
  type: 'tool-call-claim';
  requestFingerprint: string;
}

/** Reserved for pod output and other incremental payloads. The relay does not emit it yet. */
export interface RelayStreamEnvelope extends RelayEnvelopeBase {
  type:    'stream';
  channel: string;
  data:    unknown;
}

export type RelayEnvelope = RelayToolCallEnvelope | RelayToolResultEnvelope | RelayToolResultAckEnvelope
  | RelayToolCallClaimEnvelope | RelayStreamEnvelope;

export interface RelayRequestIdentity {
  deviceId: string;
  userId: string;
  ctx: RelayToolExecutionContext;
  category: string;
  tool: string;
  args: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${ value.map(item => canonicalJson(item)).join(',') }]`;
  const record = value as Record<string, unknown>;
  return `{${ Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${ JSON.stringify(key) }:${ canonicalJson(record[key]) }`).join(',') }}`;
}

/** Stable identity shared by the tool host, relay replicas and Desktop tunnel. */
export function relayRequestFingerprint(identity: RelayRequestIdentity): string {
  return createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

/** Individual results are bounded before WebSocket framing can affect shared traffic. */
export const RELAY_TOOL_RESULT_MAX_BYTES = 1024 * 1024;
/** Must exceed the per-result cap to let the relay isolate a malformed 3 MB result. */
export const RELAY_TUNNEL_WIRE_MAX_BYTES = 4 * 1024 * 1024;
/** Allows a reconnect to return a burst of tool results without unbounded retention. */
export const RELAY_RESULT_OUTBOX_MAX_ENTRIES = 100;
export const RELAY_RESULT_OUTBOX_MAX_BYTES = 5 * 1024 * 1024;
/** Keep room for a compact explicit backpressure/oversize response per in-flight result. */
export const RELAY_RESULT_OUTBOX_ERROR_RESERVE_BYTES = 256 * 1024;
