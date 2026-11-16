// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalVaultState } from './LocalVaultStatusContracts.js';

/** Migration, master-key rotation, recovery, password rewrap and enrollment wire shapes. */
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

export interface AccountPasswordRewrapRequest {
  /** base64url account master key, exactly 32 bytes; accepted only from Desktop approval identity over pinned TLS. */
  masterKey: string;
  /** Stable Sulla Cloud user id. Binds this local vault to one Cloud account. */
  cloudUserId: string;
  kdf: { alg: 'argon2id13'; salt: string; memoryBytes: number; ops: number };
}

export interface AccountPasswordRewrapResponse {
  migrated: boolean;
  recoveryKey?: string;
  recoveryCreated: boolean;
  cacheMode: 'helper-update-required';
}

export interface RecoveryKeyRotateResponse {
  recoveryKey: string;
  replacedExisting: boolean;
}


export interface VaultEnrollmentWrapRequest {
  requestId:string; vaultId:string; vaultEpoch:number; publicKey:string; bundle:unknown; head:unknown; records?:unknown; approved:boolean;
}
export interface VaultEnrollmentAdoptRequest {
  requestId:string; vaultId:string; vaultEpoch:number; privateKeyJwk:JsonWebKey; wrappedUserKey:unknown; masterKey:string; cloudUserId:string;
}

export interface VaultDeviceApprovalWrapRequest {
  requestId: string;
  vaultId: string;
  vaultEpoch: number;
  publicKey: string;
  approved: boolean;
}

export interface RecoverVaultRequest {
  callerId:      string;
  challengeId:   string;
  clientProof:   string;
  recoveryCode:  string;
  nextMasterKey: string;
}
