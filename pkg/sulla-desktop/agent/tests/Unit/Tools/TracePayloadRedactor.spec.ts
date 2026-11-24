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
      api_token: 'fixture-api-token',
      slack_bot_token: 'fixture-bot-token',
      client_secret: 'fixture-client-secret',
      nested: { authToken: 'fixture-auth-token' },
      output: 'Bearer abc sk-abcdefghijklm github_pat_abcdefghijklm',
    });

    expect(payload).toContain('"api_token": "[REDACTED]"');
    expect(payload).not.toContain('fixture-api-token');
    expect(payload).not.toContain('fixture-bot-token');
    expect(payload).not.toContain('fixture-client-secret');
    expect(payload).not.toContain('fixture-auth-token');
    expect(payload).not.toContain('Bearer abc');
    expect(payload).not.toContain('sk-abcdefghijklm');
    expect(payload).not.toContain('github_pat_abcdefghijklm');
  });

  it('redacts quoted values containing spaces in command and log text', () => {
    // risk: secret disclosure — redaction must consume the whole quoted value, not its first word.
    const payload = new TracePayloadRedactor().serialize('SLACK_BOT_TOKEN="fixture value with spaces"');

    expect(payload).not.toContain('fixture value');
    expect(payload).toContain('[REDACTED]');
  });

  it('normalizes secret aliases without redacting numeric usage fields', () => {
    // risk: secret disclosure and usage accuracy — redact named keys but retain token counts.
    const redactor = new TracePayloadRedactor();
    const safe = redactor.redact({
      accessToken: 'camel-access',
      apiToken: 'camel-api',
      api_token: 'snake-api',
      'x-api-key': 'dash-api',
      'AWS secret': 'aws-value',
      session_token: 'session-value',
      slack_bot_token: 'slack-value',
      passwd: 1234,
      password: 5678,
      credentials: 'credential-value',
      bearer: 'bearer-value',
      secret: 'secret-value',
      token: 'token-value',
      refresh_token: 'refresh-value',
      id_token: 'id-value',
      auth_token: 'auth-value',
      api_key: 'key-value',
      private_key: 'private-value',
      clientSecret: 'client-value',
      authorization: 'authorization-value',
      cookie: 'cookie-value',
      'set-cookie': 'set-cookie-value',
      max_tokens: 99,
      prompt_tokens: 24,
      completion_tokens: 8,
      tokens_used: 32,
    }) as Record<string, unknown>;

    for (const key of ['accessToken', 'apiToken', 'api_token', 'x-api-key', 'AWS secret', 'session_token', 'slack_bot_token', 'passwd', 'password', 'credentials', 'bearer', 'secret', 'token', 'refresh_token', 'id_token', 'auth_token', 'api_key', 'private_key', 'clientSecret', 'authorization', 'cookie', 'set-cookie']) {
      expect(safe[key]).toBe('[REDACTED]');
    }
    expect(safe).toMatchObject({ max_tokens: 99, prompt_tokens: 24, completion_tokens: 8, tokens_used: 32 });
    expect(JSON.stringify(safe)).not.toMatch(/camel-access|camel-api|snake-api|dash-api|aws-value|session-value|slack-value|credential-value|bearer-value|secret-value|token-value|refresh-value|id-value|auth-value|key-value|private-value|client-value|authorization-value|cookie-value|set-cookie-value|1234|5678/);
  });

  it('redacts named assignments and common provider credentials, including truncated PEM', () => {
    // risk: secret disclosure — visible notes and restored payloads must not expose credentials.
    const redactor = new TracePayloadRedactor();
    const text = [
      'apiToken=camel-secret', 'x-api-key: dash-secret', 'AWS secret = aws-secret',
      'session_token="session-secret"', 'passwd=plain-pass', 'credentials: listed-secret',
      'Bearer abc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.signature',
      `AKIA${'A'.repeat(16)}`, `ASIA${'B'.repeat(16)}`, `AIza${'C'.repeat(35)}`,
      `sk-ant-${'D'.repeat(20)}`, `sk_live_${'E'.repeat(20)}`, `rk_live_${'F'.repeat(20)}`,
      `ya29.${'G'.repeat(24)}`, '-----BEGIN RSA PRIVATE KEY-----\ntruncated-key-material',
    ].join('\n');

    const safe = redactor.redactText(text);
    expect(safe).not.toContain('camel-secret');
    expect(safe).not.toContain('dash-secret');
    expect(safe).not.toContain('aws-secret');
    expect(safe).not.toContain('session-secret');
    expect(safe).not.toContain('plain-pass');
    expect(safe).not.toContain('listed-secret');
    expect(safe).not.toContain('Bearer abc');
    expect(safe).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(safe).not.toContain(`AKIA${'A'.repeat(16)}`);
    expect(safe).not.toContain(`ASIA${'B'.repeat(16)}`);
    expect(safe).not.toContain(`AIza${'C'.repeat(35)}`);
    expect(safe).not.toContain(`sk-ant-${'D'.repeat(20)}`);
    expect(safe).not.toContain(`sk_live_${'E'.repeat(20)}`);
    expect(safe).not.toContain(`rk_live_${'F'.repeat(20)}`);
    expect(safe).not.toContain(`ya29.${'G'.repeat(24)}`);
    expect(safe).not.toContain('truncated-key-material');
  });

  it('leaves ordinary shell, URL, query, variable, and code text unchanged', () => {
    // risk: Standard compatibility — security redaction must not rewrite benign shared tool output.
    const redactor = new TracePayloadRedactor();
    const corpus = [
      'echo "$HOME/$1" && printf "%s\\n" "$tokenCount"',
      'https://example.test/search?query=blue%20sky&max_tokens=32',
      'const tokenCount = payload.max_tokens; const promptTokens = 8;',
      'SELECT * FROM files WHERE query = \'notes\';',
      'diff --git a/src/file.ts b/src/src/file.ts\n+  return result;',
    ];
    for (const value of corpus) expect(redactor.redactText(value)).toBe(value);
    const filePatch = {
      tool: 'file_patch',
      args: {
        filePath: 'src/example.ts',
        patch: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const before = 1;\n+const after = 2;',
      },
    };
    expect(redactor.redact(filePatch)).toEqual(filePatch);
  });
});
