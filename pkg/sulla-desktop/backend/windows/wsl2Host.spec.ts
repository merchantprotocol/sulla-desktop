// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { decodeWslOutput, parseWslDistributionList, SULLA_WSL_DISTRIBUTION, Wsl2Host } from './wsl2Host';

describe('WSL2 host adapter', () => {
  it('parses UTF-8 output and keeps distro names, state, version, and default marker', () => {
    const parsed = parseWslDistributionList('  NAME              STATE           VERSION\n* Ubuntu-24.04      Running         2\n  Debian            Stopped         1\n');

    expect(parsed).toEqual([
      { name: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: true },
      { name: 'Debian', state: 'stopped', version: 1, isDefault: false },
    ]);
  });

  it('decodes WSL UTF-16LE output', () => {
    const output = Buffer.from('  NAME  STATE  VERSION\r\n* Sulla Desktop  Stopped  2\r\n', 'utf16le');

    expect(decodeWslOutput(output)).toContain('Sulla Desktop');
    expect(parseWslDistributionList(output)).toEqual([
      { name: 'Sulla Desktop', state: 'stopped', version: 2, isDefault: true },
    ]);
  });

  it('reports missing WSL without triggering an install or elevation', async() => {
    const run = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const host = new Wsl2Host(run);

    await expect(host.inspect()).resolves.toEqual({ available: false, distributions: [], error: 'ENOENT' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['--list', '--verbose']);
  });

  it('imports only a missing distro from absolute Windows asset paths with WSL2 forced', async() => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: 'NAME STATE VERSION\n' })
      .mockResolvedValueOnce({ stdout: '' });
    const verifyAsset = vi.fn().mockResolvedValue(undefined);
    const host = new Wsl2Host(run, verifyAsset);

    await host.importDistribution('C:\\Users\\test\\AppData\\Local\\Sulla\\wsl', 'C:\\Program Files\\Sulla\\resources\\win32\\sulla-wsl-rootfs.tar', 'a'.repeat(64));

    expect(run.mock.calls).toEqual([
      [['--list', '--verbose']],
      [['--import', SULLA_WSL_DISTRIBUTION, 'C:\\Users\\test\\AppData\\Local\\Sulla\\wsl', 'C:\\Program Files\\Sulla\\resources\\win32\\sulla-wsl-rootfs.tar', '--version', '2']],
    ]);
    expect(verifyAsset).toHaveBeenCalledWith('C:\\Program Files\\Sulla\\resources\\win32\\sulla-wsl-rootfs.tar', 'a'.repeat(64));
  });

  it('does not replace a registered distro or accept relative asset paths', async() => {
    const run = vi.fn().mockResolvedValue({ stdout: '* Sulla Desktop Running 2\n' });
    const host = new Wsl2Host(run, vi.fn().mockResolvedValue(undefined));

    await expect(host.importDistribution('C:\\wsl\\sulla', 'C:\\assets\\rootfs.tar', 'a'.repeat(64))).rejects.toThrow(/Refusing to replace/);
    await expect(host.importDistribution('relative\\wsl', 'C:\\assets\\rootfs.tar', 'a'.repeat(64))).rejects.toThrow(/absolute Windows paths/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses to import when the bundled rootfs provenance digest is invalid', async() => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: 'NAME STATE VERSION\n' })
      .mockResolvedValueOnce({ stdout: '' });
    const verifyAsset = vi.fn().mockRejectedValue(new Error('digest mismatch'));
    const host = new Wsl2Host(run, verifyAsset);

    await expect(host.importDistribution('C:\\wsl\\sulla', 'C:\\assets\\rootfs.tar', 'a'.repeat(64))).rejects.toThrow('digest mismatch');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('executes guest commands as argument arrays and terminates only the named distro', async() => {
    const run = vi.fn().mockResolvedValue({ stdout: '' });
    const host = new Wsl2Host(run);

    await host.runInDistribution('/usr/local/bin/sulla-runtime', ['exec', '--', 'printf', '%s', 'value with spaces']);
    await host.terminateDistribution();

    expect(run.mock.calls).toEqual([
      [['--distribution', SULLA_WSL_DISTRIBUTION, '--user', 'root', '--exec', '/usr/local/bin/sulla-runtime', 'exec', '--', 'printf', '%s', 'value with spaces']],
      [['--terminate', SULLA_WSL_DISTRIBUTION]],
    ]);
  });
});
