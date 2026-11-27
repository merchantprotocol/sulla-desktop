// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import '../../Support/TestHomeEnv';

import { describe, expect, it, vi } from 'vitest';

import { CodexService } from '../../../languagemodels/CodexService';
import { UsageRecorder } from '../../../languagemodels/UsageRecorder';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));

const context = {
  runId:       'run-1',
  convId:      'conv-1',
  threadId:    'thread-1',
  model:       'gpt-5.5',
  effort:      'medium',
  sessionMode: 'resume' as const,
};

describe('Codex usage and transcript reseeding', () => {
  it('maps Codex completion usage and Claude result usage while keeping turn order per session', () => {
    // risk: telemetry accuracy — wrong cache or reasoning counters make payload and cost analysis misleading.
    const recorder = new UsageRecorder(() => {});
    const turnCompleted = {
      type:  'turn.completed',
      usage: {
        input_tokens: 314,
        input_tokens_details: { cached_tokens: 29 },
        output_tokens: 81,
        output_tokens_details: { reasoning_tokens: 17 },
      },
    };

    const codex = recorder.recordCodex(turnCompleted.usage, context);
    const codexWithoutCache = recorder.recordCodex({ input_tokens: 3, output_tokens: 2 }, context);
    const claude = recorder.recordClaude({
      input_tokens:                410,
      cache_read_input_tokens:     120,
      cache_creation_input_tokens: 64,
      output_tokens:               37,
    }, { ...context, model: 'claude-sonnet-4' });

    expect(codex).toMatchObject({
      runId: 'run-1', convId: 'conv-1', threadId: 'thread-1', turnSeq: 1,
      inputTokens: 314, cachedInputTokens: 29, outputTokens: 81, reasoningTokens: 17,
      model: 'gpt-5.5', effort: 'medium', sessionMode: 'resume',
    });
    expect(codexWithoutCache.cachedInputTokens).toBeNull();
    expect(codexWithoutCache.turnSeq).toBe(2);
    expect(claude).toMatchObject({
      input: 410, cacheRead: 120, cacheCreation: 64, output: 37, turnSeq: 1,
      model: 'claude-sonnet-4', effort: 'medium', sessionMode: 'resume',
    });
  });

  it('trims only oversized reseed tool payloads and keeps byte counts and artifact references', () => {
    // risk: prompt evidence — oversized tool payloads bloat recovery seeds, but silently dropping the artifact pointer loses evidence.
    const service = Object.create(CodexService.prototype) as any;
    const result = `${ 'r'.repeat(17 * 1024) }\nArtifact: sulla-file://file-1?version=v3`;
    const input = { content: 'i'.repeat(17 * 1024), artifact: 'sulla-artifact://artifact-2' };
    const serialized = service.serializeFullTranscript([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: result }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo ok' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] },
    ]);

    expect(serialized).toContain(`[truncated originalBytes=${ Buffer.byteLength(JSON.stringify(input), 'utf8') } reference=sulla-artifact://artifact-2]`);
    expect(serialized).toContain(`[truncated originalBytes=${ Buffer.byteLength(result, 'utf8') } reference=sulla-file://file-1?version=v3]`);
    expect(serialized).toContain(`[tool_use Bash {"command":"echo ok"}]`);
    expect(serialized).toContain('[tool_result] ok');
    expect(serialized).toContain(`${ JSON.stringify(input).slice(0, 8 * 1024) }\n[truncated originalBytes=${ Buffer.byteLength(JSON.stringify(input), 'utf8') }`);
    expect(serialized).toContain(`[tool_result] ${ result.slice(0, 8 * 1024) }\n[truncated originalBytes=${ Buffer.byteLength(result, 'utf8') }`);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(20 * 1024);

    const smallPayloads = service.serializeFullTranscript([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo ok' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] },
    ]);
    expect(smallPayloads).toBe('Assistant: [tool_use Bash {"command":"echo ok"}]\n\nUser: [tool_result] ok');
  });

  it('leaves the live resumed prompt payload untouched', () => {
    // risk: session integrity — trim policy is for fresh/recovery seeds only, never the live resumed turn.
    const service = Object.create(CodexService.prototype) as any;
    const result = 'x'.repeat(17 * 1024);
    const messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: result }] }];

    expect(service.extractLatestUserMessage(messages)).toBe(`User:\n${ result }`);
  });
});
