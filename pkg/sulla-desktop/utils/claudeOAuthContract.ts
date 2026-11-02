// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export function isClaudeHost(hostname: string): boolean {
  return hostname === 'claude.ai' || hostname.endsWith('.claude.ai') || hostname === 'claude.com' || hostname.endsWith('.claude.com');
}

export function isClaudeOAuthCallbackUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);

    return isClaudeHost(parsed.hostname) && parsed.pathname === '/oauth/code/callback';
  } catch {
    return false;
  }
}

export type ClaudeOAuthResult =
  | { status: 'success'; success: true }
  | { status: 'cancelled' | 'timeout' | 'cli_unavailable' | 'vm_not_ready' | 'provider_error'; success: false; message: string; error: string; reason: 'user-closed' | 'timeout' | 'cli-missing' | 'vm-not-ready' | 'provider-error' };

export function claudeOAuthFailure(
  status: Exclude<ClaudeOAuthResult['status'], 'success'>,
  message: string,
): ClaudeOAuthResult {
  const reasons = {
    cancelled: 'user-closed',
    timeout: 'timeout',
    cli_unavailable: 'cli-missing',
    vm_not_ready: 'vm-not-ready',
    provider_error: 'provider-error',
  } as const;

  return { status, success: false, message, error: message, reason: reasons[status] };
}

export function claudeOAuthResultError(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return 'Claude returned an invalid sign-in response. Please try again.';
  }

  const response = result as { success?: unknown; error?: unknown };
  if (typeof response.error === 'string' && response.error.trim()) {
    return response.error;
  }
  if (response.success === true) {
    return null;
  }

  return 'Claude returned an invalid sign-in response. Please try again.';
}
