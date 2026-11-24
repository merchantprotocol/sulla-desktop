// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { TracePayloadRedactor } from '../../../tools/TracePayloadRedactor';

describe('TracePayloadRedactor', () => {
  it('redacts credential fields and token strings from trace payloads', () => {
    // risk: secret disclosure — expanded tool payloads must not expose credentials.
    const redactor = new TracePayloadRedactor();
    const payload = redactor.serialize({
      api_token: 'secret-value',
      output: 'Bearer abcdefghijklmnop sk-abcdefghijklm github_pat_abcdefghijklm',
    });

    expect(payload).toContain('"api_token": "[REDACTED]"');
    expect(payload).not.toContain('secret-value');
    expect(payload).not.toContain('abcdefghijklmnop');
    expect(payload).not.toContain('sk-abcdefghijklm');
    expect(payload).not.toContain('github_pat_abcdefghijklm');
  });
});
