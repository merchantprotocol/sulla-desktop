// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { TracePayloadRedactor } from './TracePayloadRedactor';

describe('TracePayloadRedactor', () => {
  const redactor = new TracePayloadRedactor();
  it('redacts credentials and tokens in every text field', () => {
    // risk: secret disclosure — trace fields are all user-visible.
    const text = 'Bearer abc slack_bot_token=xoxb-12345678 sk-live-secret ghp_12345678 password=hunter2';
    expect(redactor.redactText(text)).not.toMatch(/abc|xoxb|sk-live|ghp_|hunter2/);
  });
  it('fails closed for sensitive tools and caps serialized payloads', () => {
    // risk: wallet/vault disclosure and unbounded renderer payloads.
    expect(redactor.serialize({ input: 'private' }, 'vault/read')).toBe('Details withheld');
    expect(redactor.serialize('x'.repeat(21), 'safe', 20)).toContain('… truncated');
  });
});
