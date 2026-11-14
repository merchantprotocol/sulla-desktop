// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import type { VMExecutor } from '@pkg/backend/backend';
import { SullaFilesMountManager } from './sullaFilesMountManager';

describe('SullaFilesMountManager agent mount recovery', () => {
  it('reattaches stale running agents after a remount and leaves healthy agents alone', async() => {
    // risk: availability — live jobs must recover their Files view without restarting healthy containers
    const calls:string[][] = [];
    const execCommand = vi.fn(async(_options:unknown, ...args:string[]) => {
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
