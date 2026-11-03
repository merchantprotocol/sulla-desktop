// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface IntegrationSaveFailure {
  code: string;
  status?: number;
  message: string;
}

/** Keep actionable broker classifications without exposing internal error text to the UI. */
export function classifyIntegrationSaveFailure(error: unknown): IntegrationSaveFailure {
  const candidate = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; message?: unknown } : {};
  const code = typeof candidate.code === 'string' && candidate.code ? candidate.code : 'save_failed';
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const message = code === 'unsupported_secret_egress'
    ? 'The credential cannot be saved through this path.'
    : code === 'policy_denied' ? 'The vault policy denied this save.'
      : status === 409 ? 'The account changed while it was being saved. Try again.'
        : 'The account could not be saved. Try again.';
  return { code, status, message };
}

export function integrationSaveFailureMessage(name: string, failure: IntegrationSaveFailure): string {
  if (failure.code === 'vault_locked' || failure.status === 423) {
    return 'Your signed-in session could not be restored. Sign in to Sulla Cloud again, then try again.';
  }
  if (failure.code === 'vault_unavailable' || failure.status === 503) {
    return `Could not save ${ name }. The vault service is unavailable. Try again.`;
  }
  return `Could not save ${ name }. ${ failure.message }`;
}
