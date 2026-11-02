// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { claudeOAuthResultError, isClaudeOAuthCallbackUrl } from '../claudeOAuthContract';

describe('claudeOAuthResultError', () => {
  it('accepts the secret-free saved result', () => {
    expect(claudeOAuthResultError({ success: true })).toBeNull();
  });

  it('preserves an explicit provider error', () => {
    expect(claudeOAuthResultError({ success: false, error: 'Sign-in was closed.' })).toBe('Sign-in was closed.');
  });

  it.each([undefined, null, 'ok', {}, { success: false }, { success: 'true' }])('rejects malformed result %#', (result) => {
    expect(claudeOAuthResultError(result)).toBe('Claude returned an invalid sign-in response. Please try again.');
  });
});

describe('isClaudeOAuthCallbackUrl', () => {
  it.each([
    'https://claude.com/oauth/code/callback?code=code&state=state',
    'https://auth.claude.com/oauth/code/callback?code=code&state=state',
  ])('accepts the supported Claude callback host and path: %s', (url) => {
    expect(isClaudeOAuthCallbackUrl(url)).toBe(true);
  });

  it.each([
    'https://evilclaude.com/oauth/code/callback?code=code&state=state',
    'https://claude.com.evil.example/oauth/code/callback?code=code&state=state',
    'https://claude.com/oauth/code/callback/extra?code=code&state=state',
    'https://claude.com/not-oauth/code/callback?code=code&state=state',
    'not-a-url',
  ])('rejects a non-Claude host or incorrect callback path: %s', (url) => {
    expect(isClaudeOAuthCallbackUrl(url)).toBe(false);
  });
});
