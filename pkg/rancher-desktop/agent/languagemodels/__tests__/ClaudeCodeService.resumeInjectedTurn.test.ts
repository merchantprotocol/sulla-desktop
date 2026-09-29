/**
 * @jest-environment node
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ClaudeCodeService } from '../ClaudeCodeService';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process') as any;

  return { ...actual, spawn: jest.fn(() => ({ unref: () => {}, on: () => {}, once: () => {} })) };
});
jest.mock('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: jest.fn() }));
jest.mock('../../database/RedisClient', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(async() => {}), del: jest.fn() },
}));
jest.mock('@pkg/utils/logging', () => {
  const noopLog = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

  return { __esModule: true, default: new Proxy({}, { get: () => noopLog }) };
});
jest.mock('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { limactl: '/dev/null', lima: '/dev/null', sullaHome: '/tmp', sullaConfig: '/tmp' },
}));
jest.mock('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));
jest.mock('../../prompts/generateClaudeCodeMemoryFile', () => ({ generateClaudeCodeMemoryFile: async() => {} }));

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
  let service: ClaudeCodeService;
  let proc: any;

  beforeEach(() => {
    service = new ClaudeCodeService();
    proc = makeProc();
    const s = service as any;
    s.resolveClaudeCreds = async() => ({ oauthToken: 'test', apiKey: undefined });
    s.getSession = async() => 'sess-1';
    s.setSession = async() => {};
    s.buildUserMessageContextPrefix = async() => '';
    s.warmPoolEnabled = async() => true;
    s.speculativeBootEnabled = async() => true;
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

  beforeEach(() => { jest.useFakeTimers() });
  afterEach(() => { jest.useRealTimers() });

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
