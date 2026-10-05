// cloudflaredBinary.ts — find cloudflared for Preview Share, or install a
// pinned copy on first use so sharing works on a Mac without Homebrew.
//
// The managed copy lives in ~/Library/Application Support/Sulla/bin/<version>/
// and is only ever written after its download matches the pinned SHA-256.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLOUDFLARED_VERSION = '2026.9.3';

// SHA-256 of the release tarballs (each holds a single `cloudflared` binary),
// from github.com/cloudflare/cloudflared/releases/tag/2026.9.3.
export type ReleaseAssets = Record<string, { file: string; sha256: string }>;

const RELEASE_ASSETS: ReleaseAssets = {
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095' },
  'darwin-x64':   { file: 'cloudflared-darwin-amd64.tgz', sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977' },
};

const SYSTEM_CANDIDATES = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];

export interface CloudflaredEnv {
  home:     string;
  platform: NodeJS.Platform;
  arch:     string;
  pathEnv:  string;
  exists:   (file: string) => boolean;
}

function defaultEnv(): CloudflaredEnv {
  return {
    home:     os.homedir(),
    platform: process.platform,
    arch:     process.arch,
    pathEnv:  process.env.PATH || '',
    exists:   (file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);

        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Where Sulla keeps its own pinned cloudflared. */
export function managedCloudflaredPath(env: Pick<CloudflaredEnv, 'home' | 'platform'> = defaultEnv()): string {
  const base = env.platform === 'darwin'
    ? path.join(env.home, 'Library', 'Application Support', 'Sulla')
    : path.join(process.env.XDG_DATA_HOME || path.join(env.home, '.local', 'share'), 'sulla');

  return path.join(base, 'bin', CLOUDFLARED_VERSION, 'cloudflared');
}

/** Paths checked in order before falling back to PATH. */
export function cloudflaredCandidates(env: Pick<CloudflaredEnv, 'home' | 'platform'> = defaultEnv()): string[] {
  return [...SYSTEM_CANDIDATES, managedCloudflaredPath(env)];
}

/** An existing cloudflared (Homebrew, system, Sulla's own, or PATH), or null. */
export function findCloudflared(env: CloudflaredEnv = defaultEnv()): string | null {
  const paths = env.platform === 'win32' ? path.win32 : path.posix;
  const binary = env.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const onPath = env.pathEnv.split(paths.delimiter).filter(Boolean).map(dir => paths.join(dir.replace(/^"|"$/g, ''), binary));

  return [...cloudflaredCandidates(env), ...onPath].find(p => env.exists(p)) ?? null;
}

export interface InstallDeps {
  env:      CloudflaredEnv;
  download: (url: string) => Promise<Buffer>;
  /** Unpack `archive` (a .tgz) into `dir`. */
  extract:  (archive: string, dir: string) => Promise<void>;
  /** Pinned builds; overridable for tests. */
  assets?:  ReleaseAssets;
}

export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed (HTTP ${ res.status })`);

  return Buffer.from(await res.arrayBuffer());
}

export function extract(archive: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archive, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    tar.stderr?.on('data', (d) => { stderr += d });
    tar.once('error', reject);
    tar.once('exit', code => (code === 0 ? resolve() : reject(new Error(`tar exited ${ code }: ${ stderr.trim().slice(0, 200) }`))));
  });
}

/** Download the pinned release, check its hash, and install it. Returns the binary path. */
export async function installCloudflared(deps: InstallDeps = { env: defaultEnv(), download, extract }): Promise<string> {
  const { env } = deps;
  const asset = (deps.assets ?? RELEASE_ASSETS)[`${ env.platform }-${ env.arch }`];
  if (!asset) throw new Error(`no pinned cloudflared build for ${ env.platform }-${ env.arch }`);

  const target = managedCloudflaredPath(env);
  const dir = path.dirname(target);
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${ CLOUDFLARED_VERSION }/${ asset.file }`;
  const archive = await deps.download(url);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== asset.sha256) throw new Error(`cloudflared download failed its checksum (got ${ digest.slice(0, 12) }…)`);

  await fs.promises.mkdir(dir, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(dir, '.install-'));
  try {
    const tgz = path.join(staging, asset.file);
    await fs.promises.writeFile(tgz, archive);
    await deps.extract(tgz, staging);
    const unpacked = path.join(staging, 'cloudflared');
    await fs.promises.chmod(unpacked, 0o755);
    await fs.promises.rename(unpacked, target);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }

  return target;
}

let installing: Promise<string> | null = null;

/**
 * Resolve cloudflared, installing the pinned copy if none exists. Concurrent
 * callers share one install; a failed install can be retried.
 */
export function ensureCloudflared(deps?: InstallDeps): Promise<string> {
  const found = findCloudflared(deps?.env);
  if (found) return Promise.resolve(found);
  if (!installing) {
    installing = installCloudflared(deps).finally(() => { installing = null });
  }

  return installing;
}
