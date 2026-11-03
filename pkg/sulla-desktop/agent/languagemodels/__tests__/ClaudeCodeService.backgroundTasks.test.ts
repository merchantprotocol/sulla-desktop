/**
 * @jest-environment node
 */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../BaseLanguageModel', () => ({
  BaseLanguageModel: class {
    protected model = '';
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
  default:    { sullaRuntime: '/dev/null', sullaHome: '/tmp', sullaConfig: '/tmp', appHome: '/tmp' },
}));
jest.unstable_mockModule('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));

// Every turn spawns a fresh process through the transport; hand out fakes.
const spawned: any[] = [];
const fakeTransport = {
  runtime:   'guest',
  context:   () => Promise.resolve({ runtime: 'guest' }),
  spawn:     () => {
    const proc = makeProc();
    spawned.push(proc);
    return proc;
  },
  files:     { write: () => ({ path: '/tmp/claude-system-test.md', dispose: () => {} }) },
  terminate: async(request: any) => {
    terminations.push(request.signal);
    terminateRequests.push({ signal: request.signal, confirm: !!request.confirm });
    if (request.signal === 'KILL' && failRemoteKill) throw new Error('remote kill helper exited with code 1');
  },
};
const terminations: string[] = [];
const terminateRequests: { signal: string; confirm: boolean }[] = [];
let failRemoteKill = false;
jest.unstable_mockModule('../ProviderExecutionTransport', () => ({
  getProviderExecutionTransport: () => fakeTransport,
  requireBrokeredContainerAuth:  () => undefined,
  requireContainerToolConfig:    () => undefined,
}));

const { ClaudeCodeService, awaitBackgroundHandoff } = await import('../ClaudeCodeService');
const { classifyLLMFailure } = await import('../providerRecovery');

/**
 * Each turn runs its own `claude -p` process and closes stdin at `result`, so
 * the process exits. The one exception: background tasks (Bash
 * run_in_background, Monitor) still live at `result`. Closing stdin would make
 * the CLI stop them, so that process alone is held open until they finish and
 * the CLI's follow-up turn has run, then stdin is closed.
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

const liveOne = { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] };
const noneLive = { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
const notification = { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'sleep done' };
const init = { type: 'system', subtype: 'init', session_id: 's1' };

function makeService() {
  const service: any = new ClaudeCodeService();
  service.resolveClaudeCreds = () => Promise.resolve({ oauthToken: 'test', apiKey: '' });
  service.getSession = () => Promise.resolve('s1');
  service.setSession = () => Promise.resolve();
  service.buildUserMessageContextPrefix = () => Promise.resolve('');
  service.fallbackSystemPrompt = () => Promise.resolve('');
  const deliver = jest.fn();
  service.bgDelivery = { deliver, takePending: () => [] };

  return { service, deliver };
}

/** Start a turn and wait until its prompt reached the new process's stdin. */
async function startTurn(service: any, convId: string) {
  const before = spawned.length;
  const run = service.runClaude([{ role: 'user', content: 'do the thing' }], {}, { conversationId: convId });
  while (spawned.length === before) await flush();
  const proc = spawned[spawned.length - 1];
  const sent = await new Promise<any>(resolve => proc.stdin.once('data', (c: Buffer) => resolve(JSON.parse(c.toString().trim()))));
  proc.emit('spawn');

  return { run, proc, sent };
}

/** The CLI consumes the prompt and answers it. */
function answer(proc: any, sent: any, text: string, extra: unknown[] = []) {
  proc.stdout.write(
    line(init) +
    line({ type: 'user', isReplay: true, message: { role: 'user', content: sent.message.content } }) +
    extra.map(line).join('') +
    line({ type: 'result', is_error: false, result: text }),
  );
}

describe('ClaudeCodeService — one process per turn', () => {
  beforeEach(() => { spawned.length = 0 });

  it('closes stdin at the end of a turn with no background work, and settles on exit', async() => {
    const { service } = makeService();
    const { run, proc, sent } = await startTurn(service, 'conv-plain');

    answer(proc, sent, 'All done.');
    await flush();
    expect(proc.stdin.writableEnded).toBe(true);

    proc.emit('close', 0);
    await expect(run).resolves.toMatchObject({ text: 'All done.' });
  });

  it('spawns a fresh process for every turn, resuming the session', async() => {
    const { service } = makeService();
    for (const text of ['one', 'two']) {
      const { run, proc, sent } = await startTurn(service, 'conv-two');
      answer(proc, sent, text);
      await flush();
      proc.emit('close', 0);
      await expect(run).resolves.toMatchObject({ text });
    }
    expect(spawned).toHaveLength(2);
    expect(spawned[0]).not.toBe(spawned[1]);
  });
});

describe('ClaudeCodeService — background tasks outlive their turn', () => {
  beforeEach(() => { spawned.length = 0 });

  it('returns the turn, keeps the process until the task finishes, delivers the completion, then closes stdin', async() => {
    const { service, deliver } = makeService();
    const { run, proc, sent } = await startTurn(service, 'conv-bg');

    answer(proc, sent, 'STARTED', [liveOne]);
    await expect(run).resolves.toMatchObject({ text: 'STARTED' });
    expect(proc.stdin.writableEnded).toBe(false);
    expect(proc.kill).not.toHaveBeenCalled();

    // The task finishes; the CLI runs its own follow-up turn.
    proc.stdout.write(line(noneLive) + line(notification) + line(init) + line({ type: 'result', is_error: false, result: 'FINISHED' }));
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [convId, , notices] = deliver.mock.calls[0] as any[];
    expect(convId).toBe('conv-bg');
    expect(notices[0]).toMatchObject({ taskId: 'b1', summary: 'sleep done', followUpText: 'FINISHED' });
    expect(proc.stdin.writableEnded).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();
    proc.emit('close', 0);
  });

  it('delivers an announced completion when the held process exits without a follow-up turn', async() => {
    const { service, deliver } = makeService();
    const { run, proc, sent } = await startTurn(service, 'conv-exit');

    answer(proc, sent, 'STARTED', [liveOne]);
    await run;
    proc.stdout.write(line(notification));
    await flush();
    expect(deliver).not.toHaveBeenCalled();

    proc.emit('close', 0);
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('waits until the held process is stopped before resuming its session', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { service } = makeService();
      const first = await startTurn(service, 'conv-next');
      answer(first.proc, first.sent, 'STARTED', [liveOne]);
      await first.run;
      terminations.length = 0;

      const run = service.runClaude([{ role: 'user', content: 'next' }], {}, { conversationId: 'conv-next' });
      for (let i = 0; i < 10; i++) await flush();
      expect(first.proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(terminations).toEqual(['TERM']);
      // The old copy is not confirmed gone yet: no second process on the session.
      expect(spawned).toHaveLength(1);

      jest.advanceTimersByTime(2_000);
      while (spawned.length === 1) await flush();
      expect(terminations).toEqual(['TERM', 'KILL']);
      first.proc.emit('close', null);

      const second = spawned[1];
      const sent = await new Promise<any>(resolve => second.stdin.once('data', (c: Buffer) => resolve(JSON.parse(c.toString().trim()))));
      second.emit('spawn');
      answer(second, sent, 'Next answer.');
      await flush();
      expect(second.stdin.writableEnded).toBe(true);
      second.emit('close', 0);
      await expect(run).resolves.toMatchObject({ text: 'Next answer.' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a Stop during the handoff ends the turn without starting a process', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { service } = makeService();
      const first = await startTurn(service, 'conv-stop');
      answer(first.proc, first.sent, 'STARTED', [liveOne]);
      await first.run;

      const abort = new AbortController();
      const run = service.runClaude([{ role: 'user', content: 'next' }], {}, { conversationId: 'conv-stop', signal: abort.signal });
      for (let i = 0; i < 5; i++) await flush();
      abort.abort();
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(spawned).toHaveLength(1);
      jest.advanceTimersByTime(2_000);
      for (let i = 0; i < 5; i++) await flush();
      first.proc.emit('close', null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a CLI that dies right after a handoff is a Sulla fault, never a provider failure', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { service } = makeService();
      const first = await startTurn(service, 'conv-fault');
      answer(first.proc, first.sent, 'STARTED', [liveOne]);
      await first.run;

      const run = service.runClaude([{ role: 'user', content: 'next' }], {}, { conversationId: 'conv-fault' });
      for (let i = 0; i < 5; i++) await flush();
      jest.advanceTimersByTime(2_000);
      while (spawned.length === 1) await flush();
      first.proc.emit('close', null);
      const second = spawned[1];
      second.emit('spawn');
      second.emit('close', 137);

      const error: any = await run.catch((e: unknown) => e);
      expect(error).toMatchObject({ cliFault: true, sullaInternal: true, code: 'SULLA_INFRA' });
      expect(classifyLLMFailure(error).kind).toBe('infrastructure');
    } finally {
      jest.useRealTimers();
    }
  });

  it('the same fault on a turn with no handoff stays an ordinary CLI fault', async() => {
    const { service } = makeService();
    const run = service.runClaude([{ role: 'user', content: 'hi' }], {}, { conversationId: 'conv-nohandoff' });
    while (spawned.length === 0) await flush();
    spawned[0].emit('spawn');
    spawned[0].emit('close', 137);

    const error: any = await run.catch((e: unknown) => e);
    expect(error).toMatchObject({ cliFault: true, sullaInternal: false });
    expect(error.code).toBeUndefined();
  });

  it('an unconfirmed stop of the held process fails closed until the KILL is confirmed', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { service } = makeService();
      const first = await startTurn(service, 'conv-unconfirmed');
      answer(first.proc, first.sent, 'STARTED', [liveOne]);
      await first.run;
      failRemoteKill = true;
      terminateRequests.length = 0;

      const run = service.runClaude([{ role: 'user', content: 'next' }], {}, { conversationId: 'conv-unconfirmed' });
      for (let i = 0; i < 5; i++) await flush();
      jest.advanceTimersByTime(2_000);
      const error: any = await run.catch((e: unknown) => e);

      expect(error).toMatchObject({ name: 'CliHandoffFailure', code: 'SULLA_INFRA' });
      expect(classifyLLMFailure(error).kind).toBe('infrastructure');
      // The handoff asks the transport to confirm the KILL.
      expect(terminateRequests).toContainEqual({ signal: 'KILL', confirm: true });
      // The old CLI may still be alive: no second process on its session.
      expect(spawned).toHaveLength(1);

      // Even after the held process's local side closes, a resend still fails
      // closed while the remote KILL stays unconfirmed.
      first.proc.emit('close', null);
      await flush();
      const resend: any = await service.runClaude([{ role: 'user', content: 'again' }], {}, { conversationId: 'conv-unconfirmed' }).catch((e: unknown) => e);
      expect(resend).toMatchObject({ name: 'CliHandoffFailure' });
      expect(spawned).toHaveLength(1);

      // Once the KILL is confirmed, the next turn resumes normally.
      failRemoteKill = false;
      const ok = service.runClaude([{ role: 'user', content: 'third' }], {}, { conversationId: 'conv-unconfirmed' });
      while (spawned.length === 1) await flush();
      const second = spawned[1];
      const sent = await new Promise<any>(resolve => second.stdin.once('data', (c: Buffer) => resolve(JSON.parse(c.toString().trim()))));
      second.emit('spawn');
      answer(second, sent, 'Back.');
      await flush();
      second.emit('close', 0);
      await expect(ok).resolves.toMatchObject({ text: 'Back.' });
    } finally {
      failRemoteKill = false;
      jest.useRealTimers();
    }
  });

  it('an ordinary turn right after a successful handoff keeps provider attribution for its faults', async() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { service } = makeService();
      const first = await startTurn(service, 'conv-after');
      answer(first.proc, first.sent, 'STARTED', [liveOne]);
      await first.run;

      const handoff = service.runClaude([{ role: 'user', content: 'next' }], {}, { conversationId: 'conv-after' });
      for (let i = 0; i < 5; i++) await flush();
      jest.advanceTimersByTime(2_000);
      while (spawned.length === 1) await flush();
      first.proc.emit('close', null);
      const second = spawned[1];
      const sent = await new Promise<any>(resolve => second.stdin.once('data', (c: Buffer) => resolve(JSON.parse(c.toString().trim()))));
      second.emit('spawn');
      answer(second, sent, 'Next answer.');
      await flush();
      second.emit('close', 0);
      await expect(handoff).resolves.toMatchObject({ text: 'Next answer.' });

      // Same conversation, seconds later, no held process: a genuine CLI fault.
      const ordinary = service.runClaude([{ role: 'user', content: 'again' }], {}, { conversationId: 'conv-after' });
      while (spawned.length === 2) await flush();
      spawned[2].emit('spawn');
      spawned[2].emit('close', 137);

      const error: any = await ordinary.catch((e: unknown) => e);
      expect(error).toMatchObject({ cliFault: true, sullaInternal: false });
      expect(error.code).toBeUndefined();
      expect(classifyLLMFailure(error).kind).not.toBe('infrastructure');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not touch a held process that belongs to another conversation', async() => {
    const { service } = makeService();
    const held = await startTurn(service, 'conv-a');
    answer(held.proc, held.sent, 'STARTED', [liveOne]);
    await held.run;

    const other = await startTurn(service, 'conv-b');
    answer(other.proc, other.sent, 'Other.');
    await flush();
    other.proc.emit('close', 0);
    await other.run;

    expect(held.proc.kill).not.toHaveBeenCalled();
    held.proc.emit('close', 0);
  });

  it('stops a held process at the hold limit', async() => {
    // Fake only the clocks the hold uses; streams still need real ticks.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { service } = makeService();
      const { run, proc, sent } = await startTurn(service, 'conv-limit');
      answer(proc, sent, 'STARTED', [liveOne]);
      await run;

      jest.advanceTimersByTime(4 * 60 * 60_000 - 1);
      expect(proc.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', null);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('awaitBackgroundHandoff', () => {
  it('a stop that rejects is failed, never stopped', async() => {
    await expect(awaitBackgroundHandoff(Promise.reject(new Error('kill not confirmed')))).resolves.toBe('failed');
    await expect(awaitBackgroundHandoff(Promise.resolve())).resolves.toBe('stopped');
  });

  it('a stop that never settles times out', async() => {
    await expect(awaitBackgroundHandoff(new Promise<void>(() => {}), undefined, 10)).resolves.toBe('timed_out');
  });

  it('an already-aborted turn rejects with AbortError and leaves no unhandled rejection', async() => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(awaitBackgroundHandoff(Promise.reject(new Error('kill not confirmed')), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
