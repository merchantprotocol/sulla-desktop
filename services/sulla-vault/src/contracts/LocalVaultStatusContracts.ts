// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Local vault state, error and status wire shapes. */
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
  /** Clerk-only safe display context; contains neither a credential nor request body. */
  approvalContext?: {
    selectedEnvironment: 'staging' | 'production';
    effectiveEnvironment: 'staging' | 'production';
    instanceId: string;
    method: string;
    path: string;
    query: string;
    options: Record<string, string | boolean>;
    requesterAgentId: string;
    jobId: string | null;
    threadId: string | null;
    action: string;
    changes: Record<string, string>;
  };
  /** Non-secret diagnostic reason for egress failures, e.g. `connect_ECONNREFUSED` or `dns_EAI_AGAIN`. */
  reason?: string;
  /** True when the failure is a transient egress problem the caller may retry after a pause. */
  retryable?: boolean;
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
