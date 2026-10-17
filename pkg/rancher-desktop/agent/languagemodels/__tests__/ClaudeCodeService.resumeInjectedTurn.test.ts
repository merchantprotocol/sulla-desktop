/**
 * @jest-environment node
 */
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

  return { __esModule: true, default: new Proxy({}, { get: () => noopLog }) };
});
jest.unstable_mockModule('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { limactl: '/bin/true', lima: '/dev/null', sullaHome: '/tmp', sullaConfig: '/tmp' },
}));
jest.unstable_mockModule('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));
jest.unstable_mockModule('../../prompts/generateClaudeCodeMemoryFile', () => ({ generateClaudeCodeMemoryFile: async() => {} }));

const { ClaudeCodeService, resetClaudeProcessPool } = await import('../ClaudeCodeService');
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

  return proc;
}

const line = (o: unknown) => `${ JSON.stringify(o) }\n`;
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('ClaudeCodeService — turns the CLI runs before our prompt', () => {
  let service: ClaudeCodeServiceInstance;
  let proc: any;

  beforeEach(() => {
    resetClaudeProcessPool();
    service = new ClaudeCodeService();
    proc = makeProc();
    const s = service as any;
    s.resolveClaudeCreds = () => Promise.resolve({ oauthToken: 'test', apiKey: undefined });
    s.getSession = () => Promise.resolve('sess-1');
    s.setSession = () => Promise.resolve();
    s.buildUserMessageContextPrefix = () => Promise.resolve('');
    s.warmPoolEnabled = () => Promise.resolve(true);
    s.speculativeBootEnabled = () => Promise.resolve(true);
    s.bgDelivery = { deliver: jest.fn(), takePending: () => [] };
    s.prewarmed.set('conv', {
      proc,
      mcpSession:    null,
      mcpConfigPath: null,
      pidFile:       '/tmp/sulla-claude-test.pid',
      model:         'claude-code',
      createdAt:     Date.now(),
      closed:        false,
      busy:          false,
      reapTimer:     null,
    });
  });

  afterEach(() => {
    for (const rec of (service as any).prewarmed.values()) {
      if (rec.reapTimer) clearTimeout(rec.reapTimer);
    }
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

    await expect(run).resolves.toMatchObject({ text: 'All good.' });
  });
});

describe('ClaudeCodeService — warm pool min/max', () => {
  const mk = () => ({ proc: makeProc(), mcpSession: null, mcpConfigPath: null, pidFile: '/tmp/x.pid', model: 'claude-code', createdAt: Date.now(), closed: false, busy: false, reapTimer: null }) as any;

  beforeEach(() => { jest.useFakeTimers(); resetClaudeProcessPool() });
  afterEach(() => { jest.useRealTimers() });

  it('is one pool across every service instance (one per model/agent)', () => {
    const opus = new ClaudeCodeService() as any;
    const sonnet = new ClaudeCodeService() as any;
    opus.poolMin = sonnet.poolMin = 3;
    opus.poolMax = sonnet.poolMax = 3;
    const recs = Array.from({ length: 4 }, mk);
    recs.forEach((r, i) => {
      jest.advanceTimersByTime(1_000);
      const owner = i % 2 ? sonnet : opus;
      owner.prewarmed.set(`c${ i }`, r);
      owner.markIdle(r, `c${ i }`);
    });

    // Max is enforced across both instances, not per instance.
    expect(opus.idle.size).toBe(3);
    expect(sonnet.idle).toBe(opus.idle);
    expect(recs[0].proc.kill).toHaveBeenCalled();
  });

  it('a chat parked by one instance is not left alive when another instance takes the turn', () => {
    const opus = new ClaudeCodeService() as any;
    const sonnet = new ClaudeCodeService() as any;
    opus.setModel('claude-opus-5-5');
    const r = mk();
    r.model = 'claude-opus-5-5';
    opus.prewarmed.set('chat', r);
    opus.markIdle(r, 'chat');

    // The other instance sees the parked process and retires it (model
    // mismatch) instead of cold-spawning a second copy beside it.
    expect(sonnet.claimPrewarm('chat', 'claude-sonnet-5')).toBeNull();
    expect(r.proc.kill).toHaveBeenCalled();
    expect(opus.prewarmed.has('chat')).toBe(false);
  });

  it('never keeps more than max idle — retires the longest-idle first', () => {
    const s = new ClaudeCodeService() as any;
    s.poolMin = 5;
    s.poolMax = 5;
    const recs = Array.from({ length: 7 }, mk);
    recs.forEach((r, i) => {
      jest.advanceTimersByTime(1_000);
      s.prewarmed.set(`c${ i }`, r);
      s.markIdle(r, `c${ i }`);
    });

    expect(s.idle.size).toBe(5);
    expect(recs[0].proc.kill).toHaveBeenCalled();
    expect(recs[1].proc.kill).toHaveBeenCalled();
    expect(recs[6].proc.kill).not.toHaveBeenCalled();
    expect(s.prewarmed.has('c0')).toBe(false);
  });

  it('idle reap never takes the pool below min', () => {
    const s = new ClaudeCodeService() as any;
    s.poolMin = 5;
    s.poolMax = 5;
    const recs = Array.from({ length: 5 }, mk);
    recs.forEach((r, i) => {
      s.prewarmed.set(`c${ i }`, r);
      s.markIdle(r, `c${ i }`);
      s.armParkedReap(r, `c${ i }`);
    });

    jest.advanceTimersByTime(60 * 60_000);

    expect(s.idle.size).toBe(5);
    recs.forEach(r => expect(r.proc.kill).not.toHaveBeenCalled());
    recs.forEach(r => clearTimeout(r.reapTimer));
  });

  it('a claimed proc leaves the idle pool', () => {
    const s = new ClaudeCodeService() as any;
    const r = mk();
    s.prewarmed.set('c', r);
    s.markIdle(r, 'c');

    expect(s.claimPrewarm('c', 'claude-code')).toBe(r);
    expect(s.idle.size).toBe(0);
  });
});

describe('CLI fault recovery lifecycle', () => {
  afterEach(() => { jest.useRealTimers() });

  it('settles a stalled Claude adapter even when the child never emits close', async() => {
    jest.useFakeTimers();
    resetClaudeProcessPool();
    const service = new ClaudeCodeService() as any;
    const proc = makeProc();
    service.resolveClaudeCreds = () => Promise.resolve({ oauthToken: 'test', apiKey: undefined });
    service.getSession = () => Promise.resolve('sess-stall');
    service.setSession = jest.fn(async() => {});
    service.buildUserMessageContextPrefix = () => Promise.resolve('');
    service.warmPoolEnabled = () => Promise.resolve(true);
    service.speculativeBootEnabled = () => Promise.resolve(true);
    service.bgDelivery = { deliver: jest.fn(), takePending: () => [] };
    service.refreshPoolLimits = async() => {};
    service.waitForAutonomousTurn = async() => {};
    service.prewarmed.set('stall-conv', {
      proc,
      mcpSession:    null,
      mcpConfigPath: null,
      pidFile:       '/tmp/sulla-claude-stall.pid',
      model:         'claude-code',
      createdAt:     Date.now(),
      closed:        false,
      busy:          false,
      reapTimer:     null,
    });

    const started = new Promise<void>(resolve => proc.stdin.once('data', () => resolve()));
    const run = service.runClaude(
      [{ role: 'user', content: 'finish the task' }],
      {},
      { conversationId: 'stall-conv' },
    );
    const result = expect(run).rejects.toMatchObject({ name: 'CliFaultError', kind: 'stall' });
    await started;
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
    const fault = new Error('invalid api key');
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
