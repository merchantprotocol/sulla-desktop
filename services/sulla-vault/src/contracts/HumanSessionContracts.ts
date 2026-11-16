// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalVaultState } from './LocalVaultStatusContracts.js';

/** Human (vault UI) session and Desktop control wire shapes. */
export interface HumanSessionResponse {
  url:       string;
  csrf:      string;
  expiresAt: number;
  /** Pre-unlock sessions can only set up, unlock, or recover the vault. */
  phase:     'pre-unlock' | 'unlocked';
}

export interface BrowserFillTarget {
  tabId:  string;
  origin: string;
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

export type DesktopControlAction = 'status' | 'lock' | 'migrate' | 'create-human-session';

export interface DesktopControlIdentity {
  serviceId: string;
  token:     string;
}
