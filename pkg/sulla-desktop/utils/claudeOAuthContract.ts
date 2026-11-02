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
