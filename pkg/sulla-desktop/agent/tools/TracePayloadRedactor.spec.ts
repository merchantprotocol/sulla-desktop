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
  it('redacts env-style, YAML, JSON, and CLI secret assignments', () => {
    // risk: secret disclosure — common credential key names must fail closed at any prefix.
    const text = 'DB_PASSWORD=x AWS_SECRET_ACCESS_KEY=x export STRIPE_SECRET_KEY="x" GITHUB_TOKEN: x {\"apiKey\": \"x\"} --api-key x --token=x';
    expect(redactor.redactText(text)).not.toMatch(/DB_PASSWORD|AWS_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|GITHUB_TOKEN|apiKey|--api-key x|--token=x|\bx\b/);
  });
  it('redacts connection query and mysql attached password parameters without treating ls -p as a secret', () => {
    // risk: secret disclosure — credentials often occur outside URL userinfo.
    expect(redactor.redactText('postgres://host/db?password=hunter2&token=abc;Password=xyz;')).not.toMatch(/hunter2|abc|xyz/);
    expect(redactor.redactText('mysql -uroot -phunter2 ls -p')).not.toContain('hunter2');
    expect(redactor.redactText('ls -p')).toBe('ls -p');
  });
  it('handles long hostile input without pathological regex backtracking', () => {
    // risk: renderer denial of service from untrusted trace text.
    const started = performance.now();
    redactor.redactText('A'.repeat(200_000) + ' PASSWORD=' + 'x'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(200);
  });
  it('fails closed for sensitive tools and caps serialized payloads', () => {
    // risk: wallet/vault disclosure and unbounded renderer payloads.
    expect(redactor.serialize({ input: 'private' }, 'vault/read')).toBe('Details withheld');
    expect(redactor.serialize('x'.repeat(21), 'safe', 20)).toContain('… truncated');
  });
});
