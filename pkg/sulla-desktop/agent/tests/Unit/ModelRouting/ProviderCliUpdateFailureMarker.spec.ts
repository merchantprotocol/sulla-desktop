// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Execution-level regression for the provider CLI updater failure marker.
//
// This runs the ACTUAL generated updater script through the ACTUAL shared
// runCommand buffering (same options the product passes, including the
// 4000-character head-only cap), against owned temporary stubs for docker,
// npm and node. The only rewrite is dropping the `/bin/busybox ` prefix so the
// Linux shell logic can execute on the host with equivalent applets.
//
// What this does NOT prove: busybox ash semantics in the real VM, the
// `sulla-runtime exec -- sh -lc` transport, real npm/docker behavior, or the
// worker image. The coordinator reruns the real VM script for that.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installConfirmedProviderCli, ProviderCliUpdateError } from '@pkg/backend/providerCliUpdates';
import { withConfirmedCliUpdate } from '@pkg/shared/providerCliUpdateAuthority';

type RunResult = { stdout: string; stderr: string; exitCode: number };

const fixture = vi.hoisted(() => ({
  prefix:  '',
  runs:    [] as { options: Record<string, unknown>; result: { stdout: string; stderr: string; exitCode: number } }[],
  get:     vi.fn(),
  set:     vi.fn(),
}));

vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: fixture.get, set: fixture.set } }));
vi.mock('@pkg/agent/services/GuestRuntimeTransport', () => ({ getGuestRuntimeIdentity: () => ({ uid: 10001, gid: 10001 }) }));
vi.mock('@pkg/backend/sullaServiceImages', () => ({ resolveSullaServiceImage: () => ({ image: 'owned-fixture' }) }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('@pkg/agent/tools/models/shared', () => ({
  CLI_PROVIDERS: { 'claude-code': { command: 'claude' }, codex: { command: 'codex' } },
  getCliStatus:  vi.fn(),
}));
vi.mock('@pkg/shared/providerCliSelection', async importOriginal => ({
  ...(await importOriginal<typeof import('@pkg/shared/providerCliSelection')>()),
  providerCliPrefix: () => fixture.prefix,
}));
vi.mock('@pkg/agent/tools/util/CommandRunner', async importOriginal => {
  const actual = await importOriginal<typeof import('@pkg/agent/tools/util/CommandRunner')>();
  return {
    ...actual,
    runCommand: async(command: string, _args: string[], options: Record<string, unknown>) => {
      const portable = command.split('/bin/busybox ').join('');
      const result: RunResult = await actual.runCommand('sh', ['-c', portable], { ...options, runInGuest: false });
      fixture.runs.push({ options, result });
      return result;
    },
  };
});

const NOISE = String.raw`noise() {
  printf 'SULLA_CLI_UPDATE_FAILURE:worker-smoke\n'
  printf 'SULLA_CLI_UPDATE_FAILURE:worker-smoke\n' >&2
  i=0
  while [ "$i" -lt 150 ]; do
    printf 'npm warn noisy-line-%03d token=child-secret-output %s\n' "$i" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    printf 'npm error noisy-line-%03d token=child-secret-output %s\n' "$i" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx >&2
    i=$((i + 1))
  done
}`;

const STUBS: Record<string, string> = {
  docker: String.raw`case "$*" in
  *'uname -m'*) printf 'Linux arm64 glibc\n'; exit 0 ;;
  *'/opt/sulla-cli-check:ro'*) if [ "$SULLA_TEST_FAIL_AT" = worker-smoke ]; then noise; exit 1; fi; exit 0 ;;
esac
exit 99`,
  npm: String.raw`case "$*" in
  *--package-lock-only*) if [ "$SULLA_TEST_FAIL_AT" = dependency-lock ]; then noise; exit 1; fi; exit 0 ;;
esac
if [ "$1" = ci ]; then
  if [ "$SULLA_TEST_FAIL_AT" = dependency-install ]; then noise; exit 42; fi
  while [ "$#" -gt 0 ]; do if [ "$1" = --prefix ]; then target="$2"; fi; shift; done
  mkdir -p "$target/node_modules/.bin"
  printf '#!/bin/sh\n' > "$target/node_modules/.bin/claude"
  chmod 755 "$target/node_modules/.bin/claude"
  exit 0
fi
exit 99`,
  node: String.raw`if [ "$SULLA_TEST_FAIL_AT" = dependency-audit ]; then noise; exit 2; fi
exit 0`,
};

let root = '';
let originalPath: string | undefined;

function installStubs(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${ NOISE }\n${ body }\n`, { mode: 0o755 });
  }
}

function leftoverStages(): string[] {
  return fs.readdirSync(path.dirname(fixture.prefix)).filter(name => name.startsWith('.install-'));
}

async function update(): Promise<unknown> {
  return withConfirmedCliUpdate(() => installConfirmedProviderCli('claude-code', '2.2.0')).catch(error => error);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.runs.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-cli-marker-'));
  fixture.prefix = path.join(root, 'provider-clis', 'claude-code', '2.2.0');
  installStubs(path.join(root, 'bin'));
  originalPath = process.env.PATH;
  process.env.PATH = `${ path.join(root, 'bin') }:${ originalPath }`;
  delete process.env.SULLA_TEST_FAIL_AT;
  fixture.get.mockResolvedValue({ codex: '0.170.0' });
  fixture.set.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => ({ name: '@anthropic-ai/claude-code', version: '2.2.0' }) }));
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.SULLA_TEST_FAIL_AT;
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

function expectStaticFailure(failure: unknown, stage: string): RunResult {
  expect(failure).toBeInstanceOf(ProviderCliUpdateError);
  expect(failure).toMatchObject({ stage });
  expect((failure as Error).message).toContain('The current selection was preserved');
  expect((failure as Error).message).not.toContain('child-secret-output');
  expect(fixture.runs).toHaveLength(1);
  const { options, result } = fixture.runs[0];
  // The product's own options reached the shared runner unchanged.
  expect(options).toMatchObject({ runInGuest: true, timeoutMs: 240_000, maxOutputChars: 4_000 });
  expect(result.exitCode).not.toBe(0);
  // The shared runner really dropped the tail of the noisy child output...
  expect(result.stdout).toContain('noisy-line-000');
  expect(result.stdout.endsWith('\n[truncated]')).toBe(true);
  expect(result.stdout).not.toContain('noisy-line-149');
  // ...yet the dedicated channel carries exactly one well-formed static marker.
  expect(result.stderr).toBe(`SULLA_CLI_UPDATE_FAILURE:${ stage }\n`);
  expect(fixture.set).not.toHaveBeenCalled();
  return result;
}

describe('provider CLI updater failure marker (executed script, shared runner buffering)', () => {
  it.each(['dependency-lock', 'dependency-audit', 'dependency-install', 'worker-smoke'])(
    'fresh install reports %s after >4000 chars of noisy child output and leaves no prefix or stage',
    async stage => {
      process.env.SULLA_TEST_FAIL_AT = stage;
      expectStaticFailure(await update(), stage);
      expect(fs.existsSync(fixture.prefix)).toBe(false);
      expect(leftoverStages()).toEqual([]);
    },
  );

  it('existing prefix smoke failure reports worker-smoke and keeps the installed prefix untouched', async() => {
    fs.mkdirSync(path.join(fixture.prefix, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(fixture.prefix, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(fixture.prefix, 'node_modules', '.bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.SULLA_TEST_FAIL_AT = 'worker-smoke';

    expectStaticFailure(await update(), 'worker-smoke');
    expect(fs.existsSync(path.join(fixture.prefix, 'node_modules', '.bin', 'claude'))).toBe(true);
  });

  it('a successful fresh install emits no marker, activates atomically and preserves other selections', async() => {
    await expect(withConfirmedCliUpdate(() => installConfirmedProviderCli('claude-code', '2.2.0'))).resolves.toBeUndefined();
    expect(fixture.runs[0].result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(fs.existsSync(path.join(fixture.prefix, 'node_modules', '.bin', 'claude'))).toBe(true);
    expect(leftoverStages()).toEqual([]);
    expect(fixture.set).toHaveBeenCalledWith('approvedProviderCliVersions', { codex: '0.170.0', 'claude-code': '2.2.0' }, 'json');
  });
});
