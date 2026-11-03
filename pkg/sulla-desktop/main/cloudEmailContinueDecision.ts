// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type EmailAuthResponse<T> = { ok: boolean; error?: string; httpStatus?: number; retryAfter?: number; data?: T };

export async function registerOrSignIn<T>(
  register: () => Promise<EmailAuthResponse<T>>,
  login: () => Promise<EmailAuthResponse<T>>,
): Promise<EmailAuthResponse<T> & { isNewUser?: boolean; accountExists?: boolean }> {
  const created = await register();
  if (created.ok && created.data) return { ...created, isNewUser: true };
  if (created.httpStatus !== 409) return created;
  const signedIn = await login();
  return { ...signedIn, isNewUser: false, accountExists: true };
}
