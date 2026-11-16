// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Shapes shared by LocalVaultAuthority and its collaborators (moved verbatim from localAuthority.ts, E9).

import type { AgentPolicy, EncryptedEnvelope, VaultItemPlaintext } from '@sulla/vault-crypto';

import type { BrowserFillTarget } from '../contracts.js';
import type { PinnedAddress } from '../pinnedLookup.js';

export interface Challenge {
  callerId:    string;
  clientNonce: string;
  serverNonce: string;
  expiresAt:   number;
}

export interface StagedCacheUpdate {
  masterKey:  Buffer;
  expiresAt:  number;
  generation: number;
}

export interface HumanSession {
  csrf:      string;
  expiresAt: number;
  phase:     'pre-unlock' | 'unlocked';
  browserTarget?: BrowserFillTarget;
}

export interface UnlockedKeys {
  userId:     string;
  publicKey:  string;
  userKey:    Uint8Array;
  privateKey: Uint8Array;
  legacyVmk?: Buffer;
}

export interface ItemRow {
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

export interface LegacyIntegrationRow {
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

/** A broker destination after DNS validation, pinned to the addresses that were checked. */
export type PinnedTarget = URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] };

export interface PreparedBrokerRequest {
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
