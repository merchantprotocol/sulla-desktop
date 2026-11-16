// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultBootstrapProcess, type VaultBootstrapProcessRuntime } from './vaultBootstrapLifecycle';

const EXIT = new Error('bootstrap process exited');

const electron = vi.hoisted(() => ({
  app: { whenReady: vi.fn(async() => undefined), exit: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), decryptString: vi.fn(), encryptString: vi.fn() },
  session: { defaultSession: { setCertificateVerifyProc: vi.fn(), fetch: vi.fn() } },
}));

vi.mock('electron', () => ({ ...electron, default: electron }));

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

describe('vaultBootstrapProcess entry module', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    electron.app.whenReady.mockClear();
    electron.app.exit.mockClear();
  });

  it('does not start the helper when the module is imported', async() => {
    // risk: irreversible side effects — an import-time run executed the one-shot key handoff twice.
    vi.resetModules();
    const module = await import('./vaultBootstrapProcess');
    await Promise.resolve();
    expect(typeof module.runVaultBootstrapProcess).toBe('function');
    expect(electron.app.whenReady).not.toHaveBeenCalled();
    expect(electron.app.exit).not.toHaveBeenCalled();
  });

  it('runs the helper exactly once when the entry point is called', async() => {
    // risk: irreversible side effects — bootstrapEntry must trigger exactly one helper run and one exit.
    vi.resetModules();
    vi.stubEnv('SULLA_VAULT_TLS_FINGERPRINT_PATH', '');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { runVaultBootstrapProcess } = await import('./vaultBootstrapProcess');
    void runVaultBootstrapProcess();
    let calls: unknown[][] = [];
    try {
      await vi.waitFor(() => expect(electron.app.exit).toHaveBeenCalledOnce());
    } finally {
      calls = [...stdout.mock.calls];
      stdout.mockRestore();
    }
    expect(electron.app.whenReady).toHaveBeenCalledOnce();
    // No TLS fingerprint env in tests, so the helper must fail closed rather than report success.
    expect(electron.app.exit).toHaveBeenCalledWith(1);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('"ok":false');
  });

  it('wires the real runtime to the module-level bootstrap operations', async() => {
    // risk: crypto handoff — the factory must pass the real argv and Electron lifecycle, not stubs.
    vi.resetModules();
    const { VaultBootstrapEntry } = await import('./vaultBootstrapProcess');
    const runtime = new VaultBootstrapEntry().createRuntime();
    expect(runtime.argv).toBe(process.argv);
    await runtime.whenReady();
    runtime.exit(3);
    expect(electron.app.whenReady).toHaveBeenCalledOnce();
    expect(electron.app.exit).toHaveBeenCalledWith(3);
    expect(typeof runtime.bootstrap).toBe('function');
    expect(typeof runtime.updateMasterCache).toBe('function');
  });
});
