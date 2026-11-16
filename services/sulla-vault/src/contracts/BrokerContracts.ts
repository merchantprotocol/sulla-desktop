// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalVaultState } from './LocalVaultStatusContracts.js';

/** Broker (agent credential use), relay and Sulla Cloud request wire shapes. */
export interface BrokerRelayCreateRequest {
  claims:    BrokerClaims;
  operation: 'slack.socket-mode' | 'discord.gateway' | 'enterprise.gateway' | 'sulla-cloud.relay';
  ref:       BrokerCredentialRef;
  approvalId?: string;
  /** Opaque routing ids for `sulla-cloud.relay` only; never credentials. */
  params?:   { room: string; deviceId: string };
}
export interface BrokerRelayCreateResponse { relayId: string; expiresAt: number }
export interface BrokerRelaySendRequest { sequence?: number; type: string; payload: unknown }

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
    integration_id?: string;
    account_id?:     string;
    /** Present only for item.http, after the broker metadata list authorized this id. */
    item_id?:        string;
    /** Required for github.git; normalized as owner/repository. */
    repository?:    string;
  };
}

export interface BrokerItemMetadata {
  id:    string;
  name:  string;
  type:  'login' | 'apiKey' | 'note' | 'card' | 'identity' | 'sshKey';
  hosts: string[];
  rules: Array<{ target: 'header' | 'query'; name: string; scheme: 'raw' | 'Bearer' | 'Token' | 'Basic' }>;
}

export interface BrokerItemListRequest { claims: BrokerClaims }
export interface BrokerItemListResponse { items: BrokerItemMetadata[] }

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
  /** 'base64': raw upstream bytes returned base64-encoded in body (Files sync chunk reads only). */
  responseType?: 'json' | 'text' | 'stream' | 'binary-stream' | 'base64';
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

export interface BrokerIntegrationMetadataResponse {
  integrationId: string;
  activeAccountId?: string;
  accounts: Array<{
    accountId:  string;
    label:      string;
    connected:  boolean;
    credentialRequired: boolean;
    active:     boolean;
    revision:   number;
    properties: Record<string, string>;
  }>;
}

export interface BrokerVaultItemWriteRequest {
  claims: BrokerClaims;
  title: string;
  username?: string;
  password?: string;
  generate?: boolean;
  url?: string;
  notes?: string;
  folder?: string;
  tags?: string[];
}
export interface BrokerVaultItemUpdateRequest extends Omit<BrokerVaultItemWriteRequest, 'title' | 'generate'> {
  itemId: string;
  title?: string;
  generate?: boolean;
}
export interface BrokerVaultItemWriteResponse { itemId: string; revision: number; generated: boolean }
export interface BrokerIntegrationCredentialWriteRequest {
  claims: BrokerClaims;
  integrationId: string;
  accountId?: string;
  property: string;
  value: string;
}

export interface BrokerSetActiveAccountRequest { accountId: string }

/** Trusted Desktop-only request to create the empty account a first OAuth sign-in fills in. */
export interface BrokerOAuthAccountRequest { accountId: string; label?: string }

/** Trusted Desktop-only atomic handoff of credentials collected by Desktop UI. */
export interface BrokerIntegrationAccountImportRequest {
  accountId: string;
  label?: string;
  values: Record<string, string>;
  active?: boolean;
  connected?: boolean;
}

/** Trusted Desktop-only handoff after a fixed-host Sulla Cloud auth flow. */
export interface SullaCloudSessionAdoptRequest {
  userId:             string;
  activeContractorId: string;
  contractors:        Array<{ id: string; phone?: string; businessName?: string | null; name?: string | null; email?: string | null }>;
  accessToken:        string;
  refreshToken:       string;
}

export interface SullaCloudSessionResponse {
  userId:             string;
  activeContractorId: string;
}

/** Trusted Desktop-main request; credentials are injected and retained by the vault. */
export interface SullaCloudDesktopRequest {
  method:        string;
  path:          string;
  headers?:      Record<string, string>;
  body?:         unknown;
  bodyEncoding?: 'base64';
  responseType?: 'json' | 'text';
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
