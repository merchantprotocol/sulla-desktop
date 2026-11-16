// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VMExecutor } from '@pkg/backend/backend';
import { SullaFilesMountAdapterService } from './SullaFilesMountAdapterService';
import { SullaFilesMountCredentialService } from './SullaFilesMountCredentialService';

// Logging mkdirs under $HOME at import; keep the spec hermetic.
vi.mock('@pkg/utils/logging', () => {
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { default: new Proxy({}, { get: () => log }) };
});
vi.mock('@pkg/utils/startupTrace', () => ({
  traceEvent: vi.fn(),
  traceAsync: vi.fn(async(_label:string, work:() => Promise<unknown>) => await work()),
}));


const VALID_TOKEN = 't'.repeat(64);

/** A guest whose secret writes stay open until `finish()` is called. */
class FakeGuestWriter {
  readonly writes:string[] = [];
  private pending:(() => void)[] = [];

  readonly executor = {
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdin:{ end:(data:string) => void } };
      child.stdin = { end: (data:string) => { this.writes.push(data); this.pending.push(() => child.emit('exit', 0)) } };
      return child;
    }),
  } as unknown as VMExecutor;

  finish():void {
    this.pending.splice(0).forEach(exit => exit());
  }
}

describe('SullaFilesMountAdapterService agent mount recovery', () => {
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
      // Token probe inside the adapter container: the token is missing.
      if (args[0] === 'docker' && args[1] === 'exec' && args.includes('sh')) return '';
      return '';
    });
    const repair = vi.fn(async(_generation:number) => { mounted = true });
    const service = new SullaFilesMountAdapterService(repair, () => undefined);

    const waiting = service.waitForAdapter({ execCommand } as unknown as VMExecutor, 1);
    await vi.advanceTimersByTimeAsync(31_000);
    await waiting;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30_000);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith(1);
  });

  it('reattaches stale running agents after a remount and leaves healthy agents alone', async() => {
    // risk: availability — live jobs must recover their Files view without restarting healthy containers
    const calls:string[][] = [];
    const timeouts:string[] = [];
    const execCommand = vi.fn(async(_options:unknown, ...raw:string[]) => {
      // Probes and reattaches run under `timeout N`; record the wrapped command.
      if (raw[0] === 'timeout') timeouts.push(`${ raw[2] }:${ raw[1] }`);
      const args = raw[0] === 'timeout' ? raw.slice(2) : raw;
      calls.push(args);
      if (args[0] === 'docker' && args[1] === 'ps') return 'sulla-agent-healthy\nsulla-agent-stale\nother-container';
      if (args[0] === 'docker' && args[1] === 'inspect') return args.at(-1) === 'sulla-agent-healthy' ? '101' : '202';
      if (args[0] === 'nsenter' && args[2] === '101') return '';
      if (args[0] === 'nsenter') throw new Error('Transport endpoint is not connected');
      return '';
    });
    const service = new SullaFilesMountAdapterService(async() => undefined, () => undefined);

    await service.reattachStaleAgentMounts({ execCommand } as unknown as VMExecutor);

    expect(calls.filter(call => call[0] === 'python3')).toHaveLength(1);
    expect(calls.find(call => call[0] === 'python3')?.slice(-2)).toEqual(['202', '/mnt/sulla-files']);
    expect(calls.filter(call => call[0] === 'nsenter')).toHaveLength(2);
    expect(calls.some(call => call[0] === 'python3' && call[3] === '101')).toBe(false);
    expect(calls.some(call => call[0] === 'docker' && call[1] === 'inspect' && call.at(-1) === 'other-container')).toBe(false);
    expect(timeouts).toEqual(['nsenter:5', 'nsenter:5', 'python3:10']);
  });
});

describe('SullaFilesMountCredentialService token custody', () => {
  it('lets lock wait for an in-flight token write before tearing the guest down', async() => {
    // risk: data integrity — lock must not remove the token file while a write is still landing it.
    const guest = new FakeGuestWriter();
    const service = new SullaFilesMountCredentialService(() => guest.executor, () => async() => ({ token: VALID_TOKEN }), () => 1);

    const write = service.refresh(1);
    await vi.waitFor(() => expect(guest.writes).toHaveLength(1));
    let settled = false;
    const settling = service.settle().then(() => { settled = true });
    await Promise.resolve();
    expect(settled).toBe(false);

    guest.finish();
    await write;
    await settling;
    expect(settled).toBe(true);
    expect(guest.writes[0]).toBe(`${ VALID_TOKEN }\n`);
  });

  it('refuses to write a token into a guest that was torn down while credentials were fetched', async() => {
    // risk: security — a token must never be spawned into a guest the manager has already released.
    const guest = new FakeGuestWriter();
    let current:VMExecutor | undefined = guest.executor;
    const provider = async() => {
      current = undefined;
      return { token: VALID_TOKEN };
    };
    const service = new SullaFilesMountCredentialService(() => current, () => provider, () => 1);

    await expect(service.refresh(1)).rejects.toThrow('Files mount guest is unavailable');
    expect(guest.executor.spawn).not.toHaveBeenCalled();
  });

  it('rejects a write whose credential generation changed during the fetch', async() => {
    // risk: security — a stale lock/unlock generation must not overwrite the current token.
    const guest = new FakeGuestWriter();
    let generation = 1;
    const provider = async() => {
      generation = 2;
      return { token: VALID_TOKEN };
    };
    const service = new SullaFilesMountCredentialService(() => guest.executor, () => provider, () => generation);

    await expect(service.refresh(1)).rejects.toThrow('Files mount credential generation changed');
    expect(guest.executor.spawn).not.toHaveBeenCalled();
  });
});
