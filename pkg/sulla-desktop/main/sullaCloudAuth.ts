// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Sulla Cloud authentication entry point.
 *
 * Signs in to the same sulla-workers account used by Sulla Mobile. The work is
 * done by the classes bound in SullaCloudAuthServiceProvider
 * (main/cloud/session and main/cloud/account); this module keeps the names the
 * rest of the app imports as thin delegates.
 *
 * User vs contractor:
 *   - `userId` is the stable identity we use to pair with the mobile app
 *     over the DesktopRelay. It does not change when the user switches
 *     businesses.
 *   - `activeContractorId` is the business currently selected. One user may
 *     belong to multiple contractors (future — today the server returns only
 *     a single contractor, so `userId === activeContractorId`).
 *
 * Three sign-in methods feed the same storage:
 *   - Phone OTP ............... sulla-cloud:send-otp / verify-otp
 *   - Email + password ........ sulla-cloud:email-login / email-register
 *   - Sign in with Apple ...... sulla-cloud:apple-sign-in (takes identity token)
 */

import { sullaCloudAuthProvider } from './cloud/session/SullaCloudAuthServiceProvider';

export { SullaCloudAuthServiceProvider, sullaCloudAuthProvider } from './cloud/session/SullaCloudAuthServiceProvider';

/**
 * D2 consumes this key when the vault is ready. Ownership transfers to the
 * caller, which must zero it after wrapping/flush. Nothing is persisted.
 */
export function takePendingCloudMasterKey(): Uint8Array | undefined {
  return sullaCloudAuthProvider.accountWrap.take();
}

export function clearPendingCloudMasterKey(): void {
  sullaCloudAuthProvider.accountWrap.clear();
}

/**
 * Something changed that may make a Cloud session loadable (e.g. the first-run
 * sign-in was just saved into the vault). Wake the restore loop, or start it
 * again if it already finished: otherwise nothing ever loads that session.
 */
export function signalSullaCloudStartupRestore(): void {
  sullaCloudAuthProvider.signalStartupRestore();
}

/**
 * Returns the currently-signed-in access token, or empty string if not
 * signed in. Automatically refreshes the token when it is within 60s of
 * expiry (or already expired), so callers never need to handle 401s.
 *
 * Used by subsystems that need to call authenticated Sulla backend
 * endpoints (e.g. the relay WebSocket) without going through IPC.
 */
export function getCurrentAccessToken(): Promise<string> {
  return sullaCloudAuthProvider.currentAccessToken();
}

/** True when non-secret Sulla Cloud account metadata identifies an active session. */
export function isCloudSignedIn(): Promise<boolean> {
  return sullaCloudAuthProvider.status.isSignedIn();
}

/**
 * Returns the active contractor id for the signed-in user, or an empty
 * string if not signed in. One user may own multiple contractors; this
 * reflects whichever they've selected in the UI. Used by the sync layer
 * as a fallback when an inbound payload doesn't embed contractor_id.
 */
export function getActiveContractorId(): Promise<string> {
  return sullaCloudAuthProvider.status.activeContractorId();
}

/**
 * Returns the signed-in user id (stable across contractor switches),
 * or an empty string if not signed in.
 */
export function getCurrentUserId(): Promise<string> {
  return sullaCloudAuthProvider.status.currentUserId();
}

/** Registers the `sulla-cloud:*` IPC channels and starts session restore. */
export function initSullaCloudAuthEvents(): void {
  sullaCloudAuthProvider.init();
}
