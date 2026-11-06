// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { AuthRevoked, QuotaExceeded, Transient, legacyProviderFailure } from '../../../languagemodels/failures';

describe('legacyProviderFailure', () => {
  it('does not call generic transport denial revoked authentication', () => {
    // risk: sign-in state corruption
    expect(legacyProviderFailure('codex', new Error('transport forbidden by proxy'))).not.toBeInstanceOf(AuthRevoked);
    expect(legacyProviderFailure('codex', new Error('access denied by provider bridge'))).not.toBeInstanceOf(AuthRevoked);
  });

  it('keeps explicit revocation, quota, and transient failures distinct', () => {
    // risk: actionable provider errors
    expect(legacyProviderFailure('codex', new Error('OAuth token was revoked'))).toBeInstanceOf(AuthRevoked);
    expect(legacyProviderFailure('claude-code', new Error('weekly limit exhausted'))).toBeInstanceOf(QuotaExceeded);
    expect(legacyProviderFailure('codex', new Error('network connection reset'))).toBeInstanceOf(Transient);
  });
});
