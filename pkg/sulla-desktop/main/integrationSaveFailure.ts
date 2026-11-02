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
  const raw = typeof candidate.message === 'string' ? candidate.message : 'The account could not be saved.';
  const message = raw.replace(/^Error:\s*/i, '').replace(/unsupported_secret_egress/gi, 'The credential cannot be saved through this path');
  return { code, status, message };
}

export function integrationSaveFailureMessage(name: string, failure: IntegrationSaveFailure): string {
  if (failure.code === 'vault_locked' || failure.status === 423) {
    return 'The vault is locked. Unlock it, then try again.';
  }
  if (failure.code === 'vault_unavailable' || failure.status === 503) {
    return `Could not save ${ name }. The vault service is unavailable. Try again.`;
  }
  return `Could not save ${ name }. ${ failure.message }`;
}
