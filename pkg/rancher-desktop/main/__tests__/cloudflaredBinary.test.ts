/** @jest-environment node */
/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for downloads, tunnels and DNS */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jest } from '@jest/globals';

import {
  CLOUDFLARED_VERSION, cloudflaredCandidates, ensureCloudflared, extract, findCloudflared, installCloudflared, managedCloudflaredPath,
  type CloudflaredEnv, type InstallDeps,
} from '@pkg/main/cloudflaredBinary';

function env(over: Partial<CloudflaredEnv> = {}, present: string[] = []): CloudflaredEnv {
  return { home: '/Users/me', platform: 'darwin', arch: 'arm64', pathEnv: '', exists: f => present.includes(f), ...over };
}

describe('binary resolution', () => {
  const managed = `/Users/me/Library/Application Support/Sulla/bin/${ CLOUDFLARED_VERSION }/cloudflared`;

  test('the managed copy lives under Application Support/Sulla and is a candidate', () => {
    expect(managedCloudflaredPath(env())).toBe(managed);
    expect(cloudflaredCandidates(env())).toEqual(['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', managed]);
  });

  test('prefers Homebrew, then Sulla\'s copy, then PATH', () => {
    expect(findCloudflared(env({}, ['/opt/homebrew/bin/cloudflared', managed]))).toBe('/opt/homebrew/bin/cloudflared');
    expect(findCloudflared(env({ pathEnv: '/opt/x/bin' }, [managed, '/opt/x/bin/cloudflared']))).toBe(managed);
    expect(findCloudflared(env({ pathEnv: `/a${ path.delimiter }/opt/x/bin` }, ['/opt/x/bin/cloudflared']))).toBe('/opt/x/bin/cloudflared');
  });

  test('returns null on a Mac with no cloudflared anywhere', () => {
    expect(findCloudflared(env({ pathEnv: '/usr/bin:/bin' }))).toBeNull();
  });
});

describe('installCloudflared', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfd-')) });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  test('refuses a download whose SHA-256 does not match the pin', async() => {
    const deps: InstallDeps = { env: env({ home }), download: async() => Buffer.from('tampered'), extract: jest.fn(async() => {}) };
    await expect(installCloudflared(deps)).rejects.toThrow('checksum');
    expect(deps.extract).not.toHaveBeenCalled();
    expect(fs.existsSync(managedCloudflaredPath(deps.env))).toBe(false);
  });

  test('installs the verified binary as executable and cleans up staging', async() => {
    // A real tgz holding a `cloudflared` file, pinned by its own hash.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cfd-src-'));
    fs.writeFileSync(path.join(src, 'cloudflared'), '#!/bin/sh\necho ok\n');
    const tgz = path.join(src, 'cf.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', src, 'cloudflared']);
    const archive = fs.readFileSync(tgz);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const download = jest.fn(async(_url: string) => archive);

    const installed = await installCloudflared({
      env: env({ home }), download, extract, assets: { 'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256 } },
    });

    expect(download).toHaveBeenCalledWith(`https://github.com/cloudflare/cloudflared/releases/download/${ CLOUDFLARED_VERSION }/cloudflared-darwin-arm64.tgz`);
    expect(installed).toBe(managedCloudflaredPath(env({ home })));
    expect(fs.statSync(installed).mode & 0o111).toBeTruthy();
    expect(fs.readdirSync(path.dirname(installed))).toEqual(['cloudflared']);
    fs.rmSync(src, { recursive: true, force: true });
  });

  test('unsupported platforms fail clearly', async() => {
    await expect(installCloudflared({ env: env({ platform: 'win32', arch: 'x64' }), download: jest.fn<any>(), extract: jest.fn<any>() }))
      .rejects.toThrow('no pinned cloudflared build for win32-x64');
  });
});

describe('ensureCloudflared', () => {
  test('uses an existing binary without downloading', async() => {
    const download = jest.fn<InstallDeps['download']>();
    await expect(ensureCloudflared({ env: env({}, ['/usr/local/bin/cloudflared']), download, extract: jest.fn<any>() }))
      .resolves.toBe('/usr/local/bin/cloudflared');
    expect(download).not.toHaveBeenCalled();
  });

  test('concurrent callers share one install and a failure can be retried', async() => {
    let release!: (b: Buffer) => void;
    const download = jest.fn(() => new Promise<Buffer>((resolve) => { release = resolve }));
    const deps: InstallDeps = { env: env({ home: os.tmpdir() }), download, extract: jest.fn<any>() };
    const a = ensureCloudflared(deps);
    const b = ensureCloudflared(deps);
    expect(a).toBe(b);
    release(Buffer.from('bad'));
    await expect(a).rejects.toThrow('checksum');
    const retry = ensureCloudflared(deps);
    expect(download).toHaveBeenCalledTimes(2);
    release(Buffer.from('bad'));
    await expect(retry).rejects.toThrow('checksum');
  });
});
