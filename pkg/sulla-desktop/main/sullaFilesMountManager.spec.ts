// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VMExecutor } from '@pkg/backend/backend';
import { SullaFilesMountManager } from './sullaFilesMountManager';

describe('SullaFilesMountManager agent mount recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('rewrites a missing token after the adapter remains in waiting-token for 30 seconds', async() => {
    // risk: availability — a lost bind-mounted token must not leave the FUSE adapter stuck indefinitely.
    vi.useFakeTimers();
    const startedAt = Date.now();
    let mounted = false;
    const execCommand = vi.fn(async(_options:unknown, ...args:string[]) => {
      if (args[0] === 'cat' && args[1] === '/proc/self/mountinfo') {
        return mounted
          ? '1 0 0:42 / /mnt/sulla-files rw - fuse.sulla-files sulla-files rw'
          : '1 0 8:1 /mnt/sulla-files /mnt/sulla-files rw - ext4 /dev/vda rw';
      }
      if (args[0] === 'docker' && args[1] === 'exec' && args[3] === 'cat') {
        return JSON.stringify({ phase: 'waiting-token', updatedAt: new Date(Date.now()).toISOString() });
      }
      if (args[0] === 'docker' && args[1] === 'exec' && args.includes('sh')) return '';
      return '';
    });
    const manager = new SullaFilesMountManager();
    const repair = vi.fn(async() => { mounted = true });

    (manager as any).refreshCredentials = repair;
    const waiting = (manager as any).waitForAdapter({ execCommand } as unknown as VMExecutor, 1) as Promise<void>;
    await vi.advanceTimersByTimeAsync(31_000);
    await waiting;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30_000);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('reattaches stale running agents after a remount and leaves healthy agents alone', async() => {
    // risk: availability — live jobs must recover their Files view without restarting healthy containers
    const calls:string[][] = [];
    const execCommand = vi.fn(async(_options:unknown, ...raw:string[]) => {
      // Probes and reattaches run under `timeout N`; record the wrapped command.
      const args = raw[0] === 'timeout' ? raw.slice(2) : raw;
      calls.push(args);
      if (args[0] === 'docker' && args[1] === 'ps') return 'sulla-agent-healthy\nsulla-agent-stale\nother-container';
      if (args[0] === 'docker' && args[1] === 'inspect') return args.at(-1) === 'sulla-agent-healthy' ? '101' : '202';
      if (args[0] === 'nsenter' && args[2] === '101') return '';
      if (args[0] === 'nsenter') throw new Error('Transport endpoint is not connected');
      return '';
    });
    const manager = new SullaFilesMountManager();

    await (manager as any).reattachStaleAgentMounts({ execCommand } as unknown as VMExecutor);

    expect(calls.filter(call => call[0] === 'python3')).toHaveLength(1);
    expect(calls.find(call => call[0] === 'python3')?.slice(-2)).toEqual(['202', '/mnt/sulla-files']);
    expect(calls.filter(call => call[0] === 'nsenter')).toHaveLength(2);
    expect(calls.some(call => call[0] === 'python3' && call[3] === '101')).toBe(false);
  });
});
