// SPDX-License-Identifier: GPL-2.0-or-later
import { spawnSync } from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildProviderCliInstallCommand, checkProviderCliVersions, newerCliRelease, installConfirmedProviderCli,
  getWorkerImageCliVersion, ProviderCliUpdateError, providerCliUpdateStageFromOutput,
} from '@pkg/backend/providerCliUpdates';
import { assertConfirmedCliUpdate, withConfirmedCliUpdate } from '@pkg/shared/providerCliUpdateAuthority';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), run: vi.fn(), cliStatus: vi.fn() }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: mocks.get, set: mocks.set } }));
vi.mock('@pkg/agent/tools/util/CommandRunner', () => ({ runCommand: mocks.run }));
vi.mock('@pkg/agent/services/GuestRuntimeTransport', () => ({ getGuestRuntimeIdentity: () => ({ uid: 10001, gid: 10001 }) }));
vi.mock('@pkg/backend/sullaServiceImages', () => ({ resolveSullaServiceImage: () => ({ image: 'owned-fixture' }) }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('@pkg/agent/tools/models/shared', () => ({
  CLI_PROVIDERS: {
    'claude-code': { command: 'claude' },
    codex:         { command: 'codex' },
    opencode:      { command: 'opencode' },
    cursor:        { command: 'cursor-agent' },
  },
  getCliStatus: mocks.cliStatus,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({});
  mocks.set.mockResolvedValue(undefined);
  mocks.run.mockImplementation((_command: string, args: string[] = []) => {
    const selectedMount = args.find(argument => argument.includes('/opt/sulla-provider-clis/'));
    const version = selectedMount?.match(/\/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?):\/opt/)?.[1];
    const provider = args[args.indexOf('--entrypoint') + 1] || 'claude';
    return { exitCode: 0, stdout: `${ provider } ${ version || '2.1.9' }`, stderr: '' };
  });
  mocks.cliStatus.mockImplementation((provider: string) => ({ installed: true, version: `${ provider } 2.1.9` }));
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const name = String(url).includes('%40openai%2Fcodex') ? '@openai/codex' : '@anthropic-ai/claude-code';
    return { ok: true, json: () => ({ name, version: name === '@openai/codex' ? '0.163.0' : '2.2.0' }) };
  }));
});

describe('provider CLI inventory and confirmed versioned updates', () => {
  it('checks every connected CLI provider and reports VM and worker image versions separately', async() => {
    const rows = await checkProviderCliVersions(['claude-code', 'codex', 'opencode', 'cursor', 'not-a-provider']);
    expect(rows.map(row => row.provider)).toEqual(['claude-code', 'codex', 'opencode', 'cursor']);
    expect(rows[0]).toMatchObject({ vmInstalled: 'claude-code 2.1.9', imageInstalled: 'claude 2.1.9', installedVersion: '2.1.9', latest: '2.2.0', updateAvailable: true, updateSupported: true });
    expect(rows[1]).toMatchObject({ vmInstalled: 'codex 2.1.9', imageInstalled: 'codex 2.1.9', latest: '0.163.0', updateSupported: true });
    expect(rows[2]).toMatchObject({ vmInstalled: 'opencode 2.1.9', updateSupported: false, updateAvailable: false });
    expect(rows[3]).toMatchObject({ vmInstalled: 'cursor 2.1.9', updateSupported: false, updateAvailable: false });
    expect(rows[2].error).toMatch(/no safe versioned worker package update path/);
    expect(mocks.cliStatus).toHaveBeenCalledTimes(4);
  });

  it('compares stable and prerelease versions without offering downgrades', () => {
    expect(newerCliRelease('2.2.1 (Claude Code)', '2.2.0')).toBe(false);
    expect(newerCliRelease('2.1.9 (Claude Code)', '2.2.0')).toBe(true);
    expect(newerCliRelease('2.2.0-beta.2', '2.2.0-beta.10')).toBe(true);
    expect(newerCliRelease('2.2.0-beta.10', '2.2.0-beta.2')).toBe(false);
    expect(newerCliRelease('2.2.0-beta.10', '2.2.0')).toBe(true);
    expect(newerCliRelease('2.2.0', '2.2.0-beta.10')).toBe(false);
  });

  it('builds a syntactically valid locked install with pre-install audit and worker-UID read-only smoke', () => {
    const script = buildProviderCliInstallCommand('claude-code', '2.2.0', '/mnt/data/sulla/provider-clis/claude-code/2.2.0', 'owned-fixture', 10001, 10001);
    const syntax = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    const install = script.slice(script.indexOf('\nelse\n'));
    const lockIndex = install.indexOf('package-lock-only');
    const auditIndex = install.indexOf('package-lock.json', lockIndex);
    const ciIndex = install.indexOf('npm ci');
    expect(lockIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(lockIndex);
    expect(auditIndex).toBeLessThan(ciIndex);
    expect(script).toContain('--ignore-scripts --engine-strict');
    expect(script).toContain('axios');
    expect(script).toContain('1.14.1');
    expect(script).toContain('0.30.4');
    expect(script).toContain('plain-crypto-js');
    expect(script).toContain('4.2.1');
    expect(script).toContain('--network=none --read-only');
    expect(script).toContain('--user 10001:10001');
    expect(script).toContain('"$stage:/opt/sulla-cli-check:ro"');
    expect(script).toContain('/bin/busybox mktemp');
    expect(script).toContain('/bin/busybox chmod');
    expect(script).toContain('mv "$stage" "$prefix"');
    expect(script.indexOf('mv "$stage" "$prefix"')).toBeGreaterThan(script.indexOf('--volume'));
    expect(script).toContain('SULLA_CLI_UPDATE_FAILURE');
    expect(script).toContain('phase=worker-abi');
    expect(script).toContain('uname -m');
    expect(script).toContain('process.report');
    expect(script).toContain('--libc="$worker_libc" --os=linux --cpu="$worker_cpu"');
    expect(script).toContain('phase=native-materialization');
    expect(script).toContain('optionalDependencies');
    expect(script).toContain('path containment check failed');
    expect(script).toContain('regular file');
    expect(script).toContain("native_package='@anthropic-ai/claude-code'-linux-");
    expect(script).toContain('phase=dependency-lock');
    expect(script).toContain('phase=dependency-audit');
    expect(script).toContain('phase=worker-smoke');
  });

  it('derives an image-default version from the worker binary and never the VM helper', async() => {
    mocks.run.mockResolvedValue({ exitCode: 0, stdout: 'codex 0.170.0', stderr: '' });

    await expect(getWorkerImageCliVersion('codex')).resolves.toBe('0.170.0');
    expect(mocks.cliStatus).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith('docker', expect.arrayContaining(['--entrypoint', 'codex']), expect.objectContaining({ runInGuest: true }));
  });

  it('requires owner confirmation and preserves existing provider selections on success', async() => {
    expect(() => assertConfirmedCliUpdate()).toThrow('require confirmation');
    mocks.get.mockResolvedValue({ codex: '0.162.1' });
    await withConfirmedCliUpdate(async() => {
      await installConfirmedProviderCli('claude-code', '2.2.0');
    });
    const [command, args, options] = mocks.run.mock.calls[0];
    expect(command).toContain('package-lock-only');
    expect(args).toEqual([]);
    expect(options).toMatchObject({ runInGuest: true, timeoutMs: 240_000 });
    expect(mocks.set).toHaveBeenCalledWith('approvedProviderCliVersions', { codex: '0.162.1', 'claude-code': '2.2.0' }, 'json');
    expect(() => assertConfirmedCliUpdate()).toThrow();
  });

  it('does not change the selected version when worker-UID smoke or saved settings validation fails', async() => {
    // Child output (stdout) cannot forge the stage; only the dedicated marker channel (stderr) counts.
    mocks.run.mockResolvedValue({ exitCode: 1, stdout: 'SULLA_CLI_UPDATE_FAILURE:dependency-install\nsecret-token', stderr: 'SULLA_CLI_UPDATE_FAILURE:worker-smoke\n' });
    const failure = await withConfirmedCliUpdate(() => installConfirmedProviderCli('claude-code', '2.2.0')).catch(error => error);
    expect(failure).toBeInstanceOf(ProviderCliUpdateError);
    expect(failure).toMatchObject({ stage: 'worker-smoke' });
    expect(failure.message).toContain('running the read-only worker smoke check');
    expect(failure.message).toContain('current selection was preserved');
    expect(failure.message).not.toContain('secret-token');
    expect(mocks.set).not.toHaveBeenCalled();

    mocks.run.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });
    mocks.get.mockResolvedValue([]);
    await expect(withConfirmedCliUpdate(() => installConfirmedProviderCli('claude-code', '2.2.0')))
      .rejects.toThrow('Saved provider CLI selections are invalid');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('accepts only known static failure markers and never surfaces command output', () => {
    expect(providerCliUpdateStageFromOutput('npm output\nSULLA_CLI_UPDATE_FAILURE:dependency-install\ntoken=secret')).toBe('dependency-install');
    expect(providerCliUpdateStageFromOutput('SULLA_CLI_UPDATE_FAILURE:worker-smoke; cat /tmp/secret')).toBeUndefined();
    expect(providerCliUpdateStageFromOutput('secret environment output')).toBeUndefined();
  });

  it('rechecks the exact publisher release and rejects unsafe provider or version input before guest execution', async() => {
    await expect(withConfirmedCliUpdate(() => installConfirmedProviderCli('codex', '0.163.0; touch /tmp/bad'))).rejects.toThrow('Unsupported');
    await expect(withConfirmedCliUpdate(() => installConfirmedProviderCli('opencode', '1.0.0'))).rejects.toThrow('Unsupported');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => ({ name: '@anthropic-ai/claude-code', version: '2.2.1' }) }));
    await expect(withConfirmedCliUpdate(() => installConfirmedProviderCli('claude-code', '2.2.0'))).rejects.toThrow('release changed');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
