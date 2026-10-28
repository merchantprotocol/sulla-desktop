/**
 * @jest-environment node
 */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CliFaultError, CLI_RECOVERY_PROMPT, runWithCliFaultRecovery } from '../cliFaultRecovery';
import { classifyLLMFailure } from '../providerRecovery';

jest.unstable_mockModule('../BaseLanguageModel', () => ({
  BaseLanguageModel: class {
    protected model = '';

    setModel(model: string) { this.model = model }
  },
  FinishReason:    { Stop: 'stop' },
  usageTokenTotal: () => 0,
}));
jest.unstable_mockModule('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: jest.fn() }));
jest.unstable_mockModule('../../database/RedisClient', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(async() => {}), del: jest.fn() },
}));
jest.unstable_mockModule('@pkg/utils/logging', () => {
  const noopLog = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

  return { __esModule: true, Log: class {}, default: new Proxy({}, { get: () => noopLog }) };
});
jest.unstable_mockModule('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { sullaRuntime: '/bin/true', sullaHome: '/tmp', sullaConfig: '/tmp' },
}));
jest.unstable_mockModule('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));
jest.unstable_mockModule('../../prompts/generateClaudeCodeMemoryFile', () => ({ generateClaudeCodeMemoryFile: async() => {} }));

// Every turn spawns a fresh process through the transport; the test sets the
// one to hand out.
let nextProc: any = null;
const fakeTransport = {
  runtime:   'guest',
  context:   () => Promise.resolve({ runtime: 'guest' }),
  spawn:     () => nextProc,
  files:     { write: () => ({ path: '/tmp/claude-system-test.md', dispose: () => {} }) },
  terminate: async() => {},
};
jest.unstable_mockModule('../ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: () => fakeTransport,
  requireBrokeredContainerAuth:  () => undefined,
  requireContainerToolConfig:    () => undefined,
}));

const { ClaudeCodeService } = await import('../ClaudeCodeService');
type ClaudeCodeServiceInstance = InstanceType<typeof ClaudeCodeService>;

/**
 * On --resume, the CLI injects a "background command didn't finish before the
 * previous session ended" notification for tasks the previous (killed)
 * process left behind, answers it with a synthetic "No response requested."
 * and emits a `result` — all BEFORE it reads our prompt. The turn used to
 * settle on that result and fail as "claude produced no output" (falling back
 * to another provider) while the CLI went on to answer the real prompt unseen.
 */

function makeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = jest.fn();
  proc.exitCode = null;
  proc.signalCode = null;

  return proc;
}

const line = (o: unknown) => `${ JSON.stringify(o) }\n`;
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('ClaudeCodeService — turns the CLI runs before our prompt', () => {
  let service: ClaudeCodeServiceInstance;
  let proc: any;

  beforeEach(() => {
    service = new ClaudeCodeService();
    proc = makeProc();
    nextProc = proc;
    const s = service as any;
    s.resolveClaudeCreds = () => Promise.resolve({ oauthToken: 'test', apiKey: undefined });
    s.getSession = () => Promise.resolve('sess-1');
    s.setSession = () => Promise.resolve();
    s.buildUserMessageContextPrefix = () => Promise.resolve('');
    s.fallbackSystemPrompt = () => Promise.resolve('');
    s.bgDelivery = { deliver: jest.fn(), takePending: () => [] };
  });

  it('ignores the injected stale-task turn and returns the answer to our prompt', async() => {
    let written = '';
    proc.stdin.on('data', (c: Buffer) => { written += c.toString() });

    const run = (service as any).runClaude(
      [{ role: 'user', content: 'what is up?' }],
      {},
      { conversationId: 'conv' },
    );
    await flush();
    await flush();

    const sent = JSON.parse(written.trim().split('\n')[0]);
    expect(sent.message.content).toContain('what is up?');

    proc.stdout.write(
      line({ type: 'system', subtype: 'init', session_id: 'sess-1' }) +
      line({ type: 'user', isReplay: true, message: { role: 'user', content: '<task-notification>\n<status>stopped</status>\n</task-notification>' } }) +
      line({ type: 'result', is_error: false, result: 'No response requested.' }) +
      line({ type: 'user', isReplay: true, message: { role: 'user', content: sent.message.content } }) +
      line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'All good.' } } }) +
      line({ type: 'result', is_error: false, result: 'All good.' }),
    );
    await flush();
    proc.emit('close', 0);

    await expect(run).resolves.toMatchObject({ text: 'All good.' });
  });
});

describe('CLI fault recovery lifecycle', () => {
  afterEach(() => { jest.useRealTimers() });

  it('settles a stalled Claude adapter even when the child never emits close', async() => {
    jest.useFakeTimers();
    const service = new ClaudeCodeService() as any;
    const proc = makeProc();
    nextProc = proc;
    service.resolveClaudeCreds = () => Promise.resolve({ oauthToken: 'test', apiKey: undefined });
    service.getSession = () => Promise.resolve('sess-stall');
    service.setSession = jest.fn(async() => {});
    service.buildUserMessageContextPrefix = () => Promise.resolve('');
    service.fallbackSystemPrompt = () => Promise.resolve('');
    service.bgDelivery = { deliver: jest.fn(), takePending: () => [] };

    const started = new Promise<void>(resolve => proc.stdin.once('data', () => resolve()));
    const run = service.runClaude(
      [{ role: 'user', content: 'finish the task' }],
      {},
      { conversationId: 'stall-conv' },
    );
    const result = expect(run).rejects.toMatchObject({ name: 'CliFaultError', kind: 'stall' });
    await started;
    proc.emit('spawn');
    await jest.advanceTimersByTimeAsync(15 * 60_000 + 30_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await jest.advanceTimersByTimeAsync(6_000);
    await result;
  });

  it('lets Stop win during retry backoff and never starts attempt two', async() => {
    const abort = new AbortController();
    let attempts = 0;
    const run = runWithCliFaultRecovery('Synthetic CLI', () => {
      attempts += 1;
      return Promise.reject(new CliFaultError('transport', 'synthetic disconnect'));
    }, {
      signal:      abort.signal,
      canRetry:    () => true,
      backoffMs: 60_000,
    });
    await Promise.resolve();
    abort.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
    expect(CLI_RECOVERY_PROMPT).toContain('Do not repeat completed tool calls');
  });

  it('does not retry permanent provider failures and preserves normal fallback classification', async() => {
    let attempts = 0;
    const fault = new CliFaultError('process_exit', 'invalid api key', undefined, false, false);
    const run = runWithCliFaultRecovery('Synthetic CLI', () => {
      attempts += 1;
      return Promise.reject(fault);
    }, { canRetry: () => true });

    await expect(run).rejects.toBe(fault);
    expect(attempts).toBe(1);
    expect(classifyLLMFailure(fault)).toMatchObject({ kind: 'auth', retryPrimary: false, fallbackAllowed: true });
  });

  it('blocks provider fallback when a tool result is uncertain', () => {
    const fault = new CliFaultError('stall', 'tool unresolved', undefined, false);

    expect(classifyLLMFailure(fault)).toMatchObject({ kind: 'unavailable', retryPrimary: false, fallbackAllowed: false });
  });

  it('exhausts a non-retryable CLI safety fault and blocks every provider restart', async() => {
    const run = runWithCliFaultRecovery('Synthetic CLI', () => Promise.reject(
      new CliFaultError('transport', 'teardown could not establish quiescence', undefined, false),
    ), { canRetry: () => true });

    const exhausted = await run.catch(error => error);
    expect(exhausted).toMatchObject({ name: 'CliRecoveryExhaustedError', cliRecoveryExhausted: true });
    expect(classifyLLMFailure(exhausted)).toMatchObject({ kind: 'unavailable', retryPrimary: false, fallbackAllowed: false });
  });
});
