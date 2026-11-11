// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DebugErrorService, type DebugError } from './DebugErrorService';

describe('DebugErrorService', () => {
  let directory = '';
  afterEach(async() => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

  it('warns only while disabled, then writes and relays full error records while enabled', async() => {
    // risk: observability — disabling debug must not change normal warning behavior, and enabling it must persist and relay diagnostics.
    directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-debug-errors-'));
    let enabled = false;
    const warnings: unknown[] = [];
    const relayed: DebugError[] = [];
    const service = new DebugErrorService({
      enabled: async() => enabled,
      append: async(file, content) => { const { appendFile, mkdir } = await import('fs/promises'); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, content, 'utf8'); },
      logsDir: () => directory,
      relay: error => relayed.push(error),
      warn: (_source, error) => warnings.push(error),
      now: () => new Date('2026-11-10T23:00:00.000Z'),
      processName: 'main',
    });
    const error = new Error('database unavailable');
    await service.reportError('agents:list', error);
    expect(warnings).toEqual([error]);
    expect(relayed).toHaveLength(0);
    enabled = true;
    await service.reportError('agents:list', error);
    expect(relayed[0]).toMatchObject({ timestamp: '2026-11-10T23:00:00.000Z', process: 'main', source: 'agents:list', message: error.message, stack: error.stack });
    const file = await readFile(path.join(directory, 'debug-errors.log'), 'utf8');
    expect(JSON.parse(file.trim())).toEqual(relayed[0]);
  });
});
