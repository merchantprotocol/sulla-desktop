// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { VaultBootstrapProcess, type VaultBootstrapProcessRuntime } from './vaultBootstrapProcess';

const EXIT = new Error('bootstrap process exited');

class BootstrapRuntimeFixture implements VaultBootstrapProcessRuntime {
  readonly output: string[] = [];
  readonly exitCodes: number[] = [];
  readonly configurePinnedTls = vi.fn();
  readonly bootstrap = vi.fn(async() => ({ state: 'unlocked' } as never));
  readonly updateMasterCache = vi.fn(async() => undefined);

  constructor(readonly argv: readonly string[] = []) {}

  async whenReady(): Promise<void> {}
  exit(code: number): void { this.exitCodes.push(code); }
  writeStdout(value: string): void { this.output.push(value); }
  waitForExit(): Promise<never> { return Promise.reject(EXIT); }
}

describe('VaultBootstrapProcess', () => {
  it('hands off the bootstrap result and exits successfully', async() => {
    // risk: crypto handoff — characterize the parent-visible one-shot bootstrap result.
    const runtime = new BootstrapRuntimeFixture();
    await expect(new VaultBootstrapProcess(runtime).run()).rejects.toBe(EXIT);
    expect(runtime.configurePinnedTls).toHaveBeenCalledOnce();
    expect(runtime.bootstrap).toHaveBeenCalledOnce();
    expect(runtime.updateMasterCache).not.toHaveBeenCalled();
    expect(runtime.output).toEqual(['{"ok":true,"state":"unlocked"}\n']);
    expect(runtime.exitCodes).toEqual([0]);
  });

  it('runs cache update mode without invoking unlock and reports completion', async() => {
    // risk: crypto handoff — cache refresh must not invoke the normal unlock flow.
    const runtime = new BootstrapRuntimeFixture(['--sulla-vault-cache-update-helper']);
    await expect(new VaultBootstrapProcess(runtime).run()).rejects.toBe(EXIT);
    expect(runtime.updateMasterCache).toHaveBeenCalledOnce();
    expect(runtime.bootstrap).not.toHaveBeenCalled();
    expect(runtime.output).toEqual(['{"ok":true,"updated":true}\n']);
    expect(runtime.exitCodes).toEqual([0]);
  });

  it('reports errors and exits nonzero when bootstrap fails', async() => {
    // risk: irreversible side effects — a failed cache/bootstrap operation must never report success.
    const runtime = new BootstrapRuntimeFixture();
    runtime.bootstrap.mockRejectedValue(new Error('proof rejected'));
    await expect(new VaultBootstrapProcess(runtime).run()).rejects.toBe(EXIT);
    expect(runtime.output).toEqual(['{"ok":false,"error":"proof rejected"}\n']);
    expect(runtime.exitCodes).toEqual([1]);
  });
});
