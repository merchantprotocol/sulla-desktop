// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The signed-in Sulla Cloud session as the vault item holds it. Secret: never log, never return to a caller. */
export interface SullaCloudSessionRecord {
  itemId:             string;
  revision:           number;
  userId:             string;
  activeContractorId: string;
  accessToken:        string;
  refreshToken:       string;
}

/**
 * Persistence port for the `sulla-cloud` vault item. The vault item format (properties access_token,
 * refresh_token, user_id, active_contractor_id) and the vault key are NOT touched by this port.
 */
export interface SullaCloudItemGateway {
  /** The active session, or null when signed out. */
  load(): Promise<SullaCloudSessionRecord | null>;
  /** Rewrites both tokens only if the row is still at `expectedRevision`. Returns the new revision, or null on a conflict. */
  replaceTokens(itemId: string, expectedRevision: number, accessToken: string, refreshToken: string): Promise<number | null>;
  /**
   * Destroys the stored token ciphertext for good (the bytes are overwritten, not just flagged deleted; the row stays only
   * as a sync tombstone) and clears the integration state. Returns whether a row was scrubbed.
   */
  purge(): Promise<boolean>;
}
