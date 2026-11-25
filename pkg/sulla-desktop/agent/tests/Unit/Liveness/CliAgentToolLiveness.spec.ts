// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The CLI child and its remote kill helper; nothing reaches a real VM.
const children = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock('child_process', async(importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  const { PassThrough: Pass } = await import('node:stream');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new Emitter(), {
        stdin: new Pass(), stdout: new Pass(), stderr: new Pass(), exitCode: null as number | null,
        kill: vi.fn(() => true), unref: vi.fn(),
      });
      // Kill helpers (every spawn after the CLI itself) finish at once.
      if (children.list.length > 0) queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null) });
      children.list.push(child);
      return child;
    }),
  };
});
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('../../../languagemodels/providerSessionStore', () => ({ providerSessionStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } }));
vi.mock('../../../tools/agents/workerMessaging', () => ({ prepareWorkerTurnPrompt: (_state: unknown, prompt: string) => prompt }));

import { createCursorAgentService } from '../../../languagemodels/CursorAgentService';

beforeEach(() => { children.list.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-24T12:00:00Z')) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() });

async function launch() {
  const service = createCursorAgentService('auto') as any;
  const run = service.runCli([{ role: 'user', content: 'Test only.' }], {}, { conversationId: 'cli-liveness-test' }).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(0);
  const proc = children.list[0] as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  const emit = (event: unknown) => proc.stdout.write(JSON.stringify(event) + '\n');
  return { proc, emit, run };
}

const shell = (subtype: string) => ({ type: 'tool_call', subtype, call_id: 'call-1', tool_call: { shellToolCall: { args: { command: 'npm test' } } } });

describe('CLI agent tool liveness', () => {
  it('treats a failed tool call as finished, so a run that then goes silent is stopped as stalled', async() => {
    // risk: a failed or cancelled tool stays "running" and a dead CLI is kept alive for two hours
    const { proc, emit } = await launch();
    emit(shell('started'));
    await vi.advanceTimersByTimeAsync(60_000);
    emit(shell('failed'));
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps a run alive while a tool call is still running past the silence limit', async() => {
    // risk: a long command with no output is killed as a stalled CLI
    const { proc, emit } = await launch();
    emit(shell('started'));
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(proc.kill).not.toHaveBeenCalled();
    emit(shell('completed'));
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
