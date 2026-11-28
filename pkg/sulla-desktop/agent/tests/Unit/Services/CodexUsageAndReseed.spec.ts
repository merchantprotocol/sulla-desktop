// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import '../../Support/TestHomeEnv';

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { CodexService } from '../../../languagemodels/CodexService';
import { getProviderExecutionTransport } from '../../../languagemodels/ProviderExecutionTransport';
import { UsageRecorder } from '../../../languagemodels/UsageRecorder';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../languagemodels/ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: vi.fn(),
  requireBrokeredContainerAuth: vi.fn(() => ({})),
  requireContainerToolConfig: vi.fn(() => ({})),
}));
vi.mock('../../../languagemodels/codexMcpConfig', () => ({
  bindCodexMcpSession: vi.fn(() => null),
  buildCodexMcpOverrides: vi.fn(() => []),
  CODEX_MCP_TOKEN_ENV: 'SULLA_TEST_TOKEN',
}));
vi.mock('../../../languagemodels/providerSessionStore', () => ({
  providerSessionStore: { get: vi.fn(async() => undefined), set: vi.fn(async() => {}), delete: vi.fn(async() => {}) },
}));
vi.mock('../../../services/AgentContainerRuntimeRegistry', () => ({ currentAgentContainerRuntime: vi.fn(() => undefined) }));
vi.mock('../../../tools/agents/workerMessaging', () => ({ prepareWorkerTurnPrompt: (_state: unknown, prompt: string) => prompt }));
vi.mock('../../../utils/steerChannel', () => ({
  markSteerDelivered: vi.fn(), markSteerPending: vi.fn(), onSteer: vi.fn(() => () => {}),
}));
vi.mock('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: vi.fn(() => ({})) }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));

const context = {
  runId:       'run-1',
  convId:      'conv-1',
  threadId:    'thread-1',
  model:       'gpt-5.5',
  effort:      'medium',
  sessionMode: 'resume' as const,
};

describe('Codex usage and transcript reseeding', () => {
  it('correlates completion usage with the dispatcher runId in state metadata', async() => {
    // risk: E1 telemetry accuracy — uncorrelated usage cannot be joined to the turn timing record.
    const proc = Object.assign(new EventEmitter(), {
      stdin:    new PassThrough(),
      stdout:   new PassThrough(),
      stderr:   new PassThrough(),
      exitCode: null,
      kill:     vi.fn(() => true),
    });
    const transport = {
      runtime:   'container',
      context:   vi.fn(async() => ({ runtime: 'container' })),
      files:     { write: vi.fn(async() => ({ path: '/tmp/test-instructions.md', dispose: vi.fn() })) },
      spawn:     vi.fn(() => proc),
      terminate: vi.fn(async() => {}),
    };
    vi.mocked(getProviderExecutionTransport).mockReturnValue(transport as any);

    const service = new CodexService('gpt-5.5', 'medium') as any;
    vi.spyOn(service, 'getSession').mockResolvedValue(undefined);
    vi.spyOn(service, 'buildUserMessageContextPrefix').mockResolvedValue({ prefix: '', stableHash: '' });
    const recorded: unknown[] = [];
    const recorder = new UsageRecorder(() => {});
    vi.spyOn(service.usageRecorder, 'recordCodex').mockImplementation((usage: unknown, usageContext: any) => {
      const sample = recorder.recordCodex(usage, usageContext);
      recorded.push(sample);
      return sample;
    });

    const result = service.runCodex([
      { role: 'system', content: 'Synthetic run instructions.' },
      { role: 'user', content: 'Run one synthetic turn.' },
    ], {}, { conversationId: 'conv-1', state: { metadata: { runId: 'run-1' } } });
    await vi.waitFor(() => expect(transport.spawn).toHaveBeenCalledOnce());

    proc.emit('spawn');
    proc.stdout.write(`${ JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }) }\n`);
    proc.stdout.write(`${ JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) }\n`);
    proc.stdout.write(`${ JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }) }\n`);
    await new Promise<void>(resolve => setImmediate(resolve));
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);

    await expect(result).resolves.toMatchObject({ text: 'ok' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      runId: 'run-1', convId: 'conv-1', threadId: 'thread-1', inputTokens: 12, outputTokens: 3,
    });
  });

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
