// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { CliFaultError } from '../../../languagemodels/cliFaultRecovery';
import { CodexFailureDiagnostics } from '../../../languagemodels/codexFailureDiagnostics';

describe('CodexFailureDiagnostics', () => {
  it('records retry correlation and typed process status without error, prompt, token, or URL text', () => {
    // risk: privacy — CLI errors can echo user prompts, credentials, and credential-bearing URLs.
    const entries: string[] = [];
    const diagnostics = new CodexFailureDiagnostics(line => entries.push(line));
    const sensitive = new Error('prompt: private request; token=sk-proj-abcdefghijk; https://user:secret@example.test/path');
    Object.assign(sensitive, { exitCode: 9, signal: 'SIGKILL' });
    diagnostics.retry(new CliFaultError('process_exit', sensitive.message, sensitive), 2, 'conv_123', 'run_456');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('"event":"retry"');
    expect(entries[0]).toContain('"conversationId":"conv_123"');
    expect(entries[0]).toContain('"runId":"run_456"');
    expect(entries[0]).toContain('"exitCode":9');
    expect(entries[0]).toContain('"signal":"SIGKILL"');
    expect(entries[0]).not.toContain('private request');
    expect(entries[0]).not.toContain('sk-proj-');
    expect(entries[0]).not.toContain('example.test');
  });

  it('bounds failure correlation values and records only fixed failure categories', () => {
    // risk: privacy — externally supplied correlation strings must not become arbitrary log payloads.
    const entries: string[] = [];
    const diagnostics = new CodexFailureDiagnostics(line => entries.push(line));
    diagnostics.failure({
      error: new Error('secret detail must not be logged'), fault: 'protocol',
      conversationId: 'conv id with prompt', runId: 'run\nwith\nlog injection', exitCode: null, signal: 'not-a-signal' as NodeJS.Signals,
    });

    expect(entries[0]).toContain('"conversationId":"invalid"');
    expect(entries[0]).toContain('"runId":"invalid"');
    expect(entries[0]).toContain('"category":"unknown"');
    expect(entries[0]).toContain('"exitCode":null');
    expect(entries[0]).toContain('"signal":null');
    expect(entries[0]).not.toContain('secret detail');
    expect(entries[0]).not.toContain('log injection');
  });
});
