// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { classifyIntegrationSaveFailure, integrationSaveFailureMessage } from '../integrationSaveFailure';

describe('integration save failures', () => {
  test('only the broker locked classification or HTTP 423 claims the vault is locked', () => {
    expect(integrationSaveFailureMessage('OpenAI', classifyIntegrationSaveFailure({ code: 'vault_locked', status: 423, message: 'locked' })))
      .toMatch(/sign in to Sulla Cloud again/i);
    expect(integrationSaveFailureMessage('OpenAI', classifyIntegrationSaveFailure({ code: 'policy_denied', status: 403, message: 'Account is locked by policy' })))
      .toBe('Could not save OpenAI. The vault policy denied this save.');
  });

  test('preserves safe classifications and sanitizes internal guard names', () => {
    const failure = classifyIntegrationSaveFailure({ code: 'unsupported_secret_egress', status: 403, message: 'unsupported_secret_egress: blocked' });
    expect(failure).toEqual({ code: 'unsupported_secret_egress', status: 403, message: 'The credential cannot be saved through this path.' });
    expect(integrationSaveFailureMessage('OpenAI', failure)).not.toMatch(/unlock (?:the )?vault|unsupported_secret_egress/i);
    expect(integrationSaveFailureMessage('OpenAI', classifyIntegrationSaveFailure({ code: 'vault_unavailable', status: 503, message: 'internal endpoint' })))
      .toBe('Could not save OpenAI. The vault service is unavailable. Try again.');
  });
});
