import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import paths from '@pkg/utils/paths';

export const GUEST_RUNTIME_ROOT = '/mnt/data/sulla/runtime';
export const GUEST_AGENT_WORKSPACES_ROOT = `${ GUEST_RUNTIME_ROOT }/agents`;
export const GUEST_PROVIDER_FILES_ROOT = `${ GUEST_RUNTIME_ROOT }/provider-transport`;
export const GUEST_AGENT_DOCS_ROOT = `${ GUEST_RUNTIME_ROOT }/docs`;

const GUEST_PATH_ROOTS = [GUEST_RUNTIME_ROOT, '/dev/shm/sulla-agent-secrets'];

function assertGuestPath(candidate: string, roots = GUEST_PATH_ROOTS): string {
  const resolved = path.posix.resolve(candidate);
  if (!roots.some(root => resolved === root || resolved.startsWith(`${ root }/`))) {
    throw new Error(`Guest runtime path escaped its bounded root: ${ candidate }`);
  }
  return resolved;
}

function limaEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LIMA_HOME: paths.lima, TERM: 'dumb' };
}

export function runGuestSync(args: string[], input?: string | Buffer): string {
  const result = childProcess.spawnSync(paths.limactl, ['shell', '0', '--', ...args], {
    env:      limaEnvironment(),
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `limactl exited ${ result.status }`).trim());
  }
  return String(result.stdout ?? '').trim();
}

export function createGuestRuntimeDirectory(parent: string, prefix: string): string {
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'runtime-';
  const created = runGuestSync([
    'sh', '-c',
    'set -eu; umask 077; install -d -m 0700 "$1"; mktemp -d "$1/$2XXXXXXXX"',
    'sulla-guest-mkdir', boundedParent, safePrefix,
  ]);
  return assertGuestPath(created, [boundedParent]);
}

export function writeGuestFileAtomic(target: string, data: string | Buffer, mode = 0o600): void {
  const boundedTarget = assertGuestPath(target);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid guest file mode');
  runGuestSync([
    'sh', '-c',
    'set -eu; umask 077; parent=$(dirname "$1"); install -d -m 0700 "$parent"; next="$1.next-$3"; trap \'rm -f "$next"\' EXIT; cat > "$next"; chmod "$2" "$next"; mv -f "$next" "$1"; trap - EXIT',
    'sulla-guest-write', boundedTarget, mode.toString(8), crypto.randomUUID(),
  ], data);
}

export function chmodGuestPath(target: string, mode: number): void {
  const boundedTarget = assertGuestPath(target);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid guest path mode');
  runGuestSync(['chmod', mode.toString(8), boundedTarget]);
}

export function chownGuestPath(target: string, uid: number, gid: number): void {
  const boundedTarget = assertGuestPath(target);
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid guest path ownership');
  runGuestSync(['sudo', 'chown', '-R', `${ uid }:${ gid }`, boundedTarget]);
}

export function removeGuestPathAtomic(target: string): void {
  const boundedTarget = assertGuestPath(target);
  if (boundedTarget === GUEST_RUNTIME_ROOT) throw new Error('Refusing to remove the guest runtime root');
  runGuestSync([
    'sh', '-c',
    'set -eu; [ -e "$1" ] || exit 0; tombstone="$1.deleting-$2"; mv "$1" "$tombstone"; rm -rf -- "$tombstone"',
    'sulla-guest-remove', boundedTarget, crypto.randomUUID(),
  ]);
}

function spawnCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += String(chunk) });
    proc.stderr.on('data', chunk => { stderr += String(chunk) });
    proc.once('error', reject);
    proc.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${ command } exited ${ code }`)));
  });
}

async function pipeToGuest(
  sourceCommand: string,
  sourceArgs: string[],
  guestArgs: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const source = childProcess.spawn(sourceCommand, sourceArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const guest = childProcess.spawn(paths.limactl, ['shell', '0', '--', ...guestArgs], {
      env:   limaEnvironment(),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let sourceError = '';
    let guestError = '';
    let sourceCode: number | null = null;
    let guestCode: number | null = null;
    let settled = false;
    const finish = () => {
      if (settled || sourceCode === null || guestCode === null) return;
      settled = true;
      if (sourceCode === 0 && guestCode === 0) resolve();
      else reject(new Error(guestError.trim() || sourceError.trim() || `Guest transfer failed (${ sourceCode }/${ guestCode })`));
    };
    source.stderr.on('data', chunk => { sourceError += String(chunk) });
    guest.stderr.on('data', chunk => { guestError += String(chunk) });
    source.once('error', error => { if (!settled) { settled = true; guest.kill(); reject(error) } });
    guest.once('error', error => { if (!settled) { settled = true; source.kill(); reject(error) } });
    source.once('close', code => { sourceCode = code ?? 1; finish() });
    guest.once('close', code => { guestCode = code ?? 1; finish() });
    source.stdout.pipe(guest.stdin);
  });
}

export async function seedGitWorktreeIntoGuest(source: string, jobKey: string): Promise<string> {
  const expectedRoot = path.join(os.homedir(), 'Sites', 'worktrees');
  const resolved = fs.realpathSync(source);
  const allowedRoot = fs.realpathSync(expectedRoot);
  if ((!resolved.startsWith(`${ allowedRoot }${ path.sep }`) && resolved !== allowedRoot) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Container workspacePath must be an existing worktree under ~/Sites/worktrees');
  }
  const git = (...args: string[]) => spawnCapture('git', ['-C', resolved, ...args]);
  const [top, commonGitDir, head, branch, remoteUrl] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    git('rev-parse', 'HEAD'),
    git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
    git('remote', 'get-url', 'origin').catch(() => ''),
  ]);
  if (fs.realpathSync(top) !== resolved) throw new Error('container workspacePath must be a Git worktree root');
  if (/[\0\r\n]/.test(remoteUrl)) throw new Error('Container workspacePath has an invalid Git remote URL');
  let parsed: URL | undefined;
  try { parsed = new URL(remoteUrl) } catch { /* scp-style SSH remote or absent */ }
  if (parsed?.username || parsed?.password) throw new Error('Refusing to transport a Git remote containing credentials');

  const repository = path.basename(path.dirname(commonGitDir));
  const prefix = `${ repository }-${ branch || `detached-${ head.slice(0, 12) }` }-${ jobKey }-`;
  const checkout = createGuestRuntimeDirectory(GUEST_AGENT_WORKSPACES_ROOT, prefix);
  const bundle = assertGuestPath(`${ checkout }.bundle-${ crypto.randomUUID() }`, [GUEST_AGENT_WORKSPACES_ROOT]);
  try {
    await pipeToGuest('git', ['-C', resolved, 'bundle', 'create', '-', '--all'], [
      'sh', '-c',
      'set -eu; umask 077; cat > "$1"; git clone --no-local "$1" "$2" >/dev/null; if [ -n "$3" ]; then git -C "$2" checkout "$3" >/dev/null; else git -C "$2" checkout --detach "$4" >/dev/null; fi; if [ -n "$5" ]; then git -C "$2" remote set-url origin "$5"; fi; rm -f "$1"',
      'sulla-git-seed', bundle, checkout, branch, head, remoteUrl,
    ]);
    return checkout;
  } catch (error) {
    try { removeGuestPathAtomic(checkout) } catch { /* retain original failure */ }
    try { removeGuestPathAtomic(bundle) } catch { /* already absent */ }
    throw error;
  }
}

export async function seedDirectoryIntoGuest(source: string, parent: string, prefix: string): Promise<string> {
  const resolved = fs.realpathSync(source);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Guest seed source is not a directory: ${ source }`);
  const target = createGuestRuntimeDirectory(parent, prefix);
  try {
    await pipeToGuest('tar', ['-C', resolved, '-cf', '-', '.'], [
      'sh', '-c', 'set -eu; tar -C "$1" -xf -', 'sulla-directory-seed', target,
    ]);
    return target;
  } catch (error) {
    try { removeGuestPathAtomic(target) } catch { /* retain original failure */ }
    throw error;
  }
}
