import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { sullaRuntimeGuestUser } from '@pkg/backend/sullaRuntime/state';
import paths from '@pkg/utils/paths';

export const GUEST_RUNTIME_ROOT = '/mnt/data/sulla/runtime';
export const GUEST_AGENT_WORKSPACES_ROOT = `${ GUEST_RUNTIME_ROOT }/agents`;
export const GUEST_PROVIDER_FILES_ROOT = `${ GUEST_RUNTIME_ROOT }/provider-transport`;
export const GUEST_AGENT_DOCS_ROOT = `${ GUEST_RUNTIME_ROOT }/docs`;
export const GUEST_CONVERSATIONS_ROOT = `${ GUEST_RUNTIME_ROOT }/conversations`;

const GUEST_PATH_ROOTS = [GUEST_RUNTIME_ROOT, '/dev/shm/sulla-agent-secrets'];
const CAPTURE_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;

export interface GuestRuntimeIdentity {
  uid: number;
  gid: number;
}

export interface GuestWorkspaceCleanupDecision {
  remove: boolean;
  reason: string;
}

function assertGuestPath(candidate: string, roots = GUEST_PATH_ROOTS): string {
  const resolved = path.posix.resolve(candidate);
  if (!roots.some(root => resolved === root || resolved.startsWith(`${ root }/`))) {
    throw new Error(`Guest runtime path escaped its bounded root: ${ candidate }`);
  }
  return resolved;
}

function guestEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, TERM: 'dumb' };
}

function boundedAppend(current: string, chunk: unknown): string {
  return `${ current }${ String(chunk) }`.slice(-CAPTURE_LIMIT);
}

function safeErrorText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(authorization|token|password|secret)([=:][^\s]+)/gi, '$1=[redacted]')
    .trim()
    .slice(-8_192);
}

export function runGuestSync(args: string[], input?: string | Buffer): string {
  const result = childProcess.spawnSync(paths.sullaRuntime, ['exec', '--', ...args], {
    env:      guestEnvironment(),
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout:   COMMAND_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = safeErrorText(String(result.stderr || result.stdout || ''));
    throw new Error(detail || `Guest command exited ${ result.status }`);
  }
  return String(result.stdout ?? '').trim();
}

let guestIdentity: { user: string; identity: GuestRuntimeIdentity } | undefined;

/** The container runs as the actual Lima login identity, never a host-derived or guessed UID. */
export function getGuestRuntimeIdentity(): GuestRuntimeIdentity {
  // Guest commands run as root on the Sulla runtime; there the login account
  // is the one the runtime created for this Mac user, looked up by name.
  const runtimeUser = sullaRuntimeGuestUser()?.name ?? '';
  if (guestIdentity?.user === runtimeUser) return guestIdentity.identity;
  const output = runtimeUser
    ? runGuestSync(['sh', '-c', 'set -eu; id -u "$1"; id -g "$1"', 'sulla-guest-id', runtimeUser])
    : runGuestSync(['sh', '-c', 'set -eu; id -u; id -g']);
  const [uid, gid] = output.split(/\s+/).map(Number);
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Could not resolve the Lima guest runtime identity');
  }
  guestIdentity = { user: runtimeUser, identity: { uid, gid } };
  return guestIdentity.identity;
}

function existingGuestPath(target: string, roots = GUEST_PATH_ROOTS): string {
  const boundedTarget = assertGuestPath(target, roots);
  const resolved = runGuestSync([
    'sh', '-c',
    'set -eu; resolved=$(realpath "$1"); case "$resolved" in "$2"|"$2"/*) printf "%s" "$resolved";; *) exit 73;; esac',
    'sulla-guest-path', boundedTarget, roots[0],
  ]);
  return assertGuestPath(resolved, roots);
}

export function createGuestRuntimeDirectory(parent: string, prefix: string): string {
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'runtime-';
  const { uid, gid } = getGuestRuntimeIdentity();
  const created = runGuestSync([
    'sh', '-c',
    [
      'set -eu',
      'umask 077',
      '[ ! -L "$5" ]',
      'sudo install -d -m 0700 -o "$3" -g "$4" "$5"',
      '[ "$(realpath "$5")" = "$5" ]',
      '[ "$(stat -c %u:%g "$5")" = "$3:$4" ]',
      '[ ! -L "$1" ]',
      'sudo install -d -m 0700 -o "$3" -g "$4" "$1"',
      'parent=$(realpath "$1")',
      'case "$parent" in "$5"|"$5"/*) ;; *) exit 73;; esac',
      '[ "$(stat -c %u:%g "$parent")" = "$3:$4" ]',
      '[ -w "$parent" ] && [ -x "$parent" ]',
      'mktemp -d "$parent/$2XXXXXXXX"',
    ].join('; '),
    'sulla-guest-mkdir', boundedParent, safePrefix, String(uid), String(gid), GUEST_RUNTIME_ROOT,
  ]);
  return existingGuestPath(created, [boundedParent]);
}

/** Create or reopen one stable, guest-owned runtime directory. */
export function ensureGuestRuntimeDirectory(parent: string, name: string): string {
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(name)) throw new Error('Invalid stable guest runtime directory name');
  const { uid, gid } = getGuestRuntimeIdentity();
  const target = assertGuestPath(path.posix.join(boundedParent, name), [boundedParent]);
  runGuestSync([
    'sh', '-c',
    [
      'set -eu', 'umask 077',
      'sudo install -d -m 0700 -o "$3" -g "$4" "$1"',
      '[ "$(realpath "$1")" = "$1" ]',
      'sudo install -d -m 0700 -o "$3" -g "$4" "$2"',
      '[ "$(realpath "$2")" = "$2" ]',
      '[ "$(stat -c %u:%g "$2")" = "$3:$4" ]',
    ].join('; '),
    'sulla-stable-guest-mkdir', boundedParent, target, String(uid), String(gid),
  ]);
  return existingGuestPath(target, [boundedParent]);
}

export function writeGuestFileAtomic(target: string, data: string | Buffer, mode = 0o600): void {
  const boundedTarget = assertGuestPath(target);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid guest file mode');
  runGuestSync([
    'sh', '-c',
    [
      'set -eu',
      'umask 077',
      'parent=$(realpath "$(dirname "$1")")',
      'case "$parent" in "$4"|"$4"/*) ;; *) exit 73;; esac',
      '[ ! -L "$1" ]',
      'next="$parent/.$(basename "$1").next-$3"',
      'trap \'rm -f -- "$next"\' EXIT',
      'cat > "$next"',
      'chmod "$2" "$next"',
      'mv -f -- "$next" "$1"',
      'trap - EXIT',
    ].join('; '),
    'sulla-guest-write', boundedTarget, mode.toString(8), crypto.randomUUID(), GUEST_RUNTIME_ROOT,
  ], data);
}

export function chmodGuestPath(target: string, mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid guest path mode');
  const resolved = existingGuestPath(target);
  runGuestSync(['chmod', mode.toString(8), '--', resolved]);
}

export function chownGuestPath(target: string, identity: GuestRuntimeIdentity): void {
  if (![identity.uid, identity.gid].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid guest path ownership');
  }
  const resolved = existingGuestPath(target);
  runGuestSync([
    'sh', '-c',
    'set -eu; sudo chown -hR "$2:$3" -- "$1"; [ "$(stat -c %u:%g "$1")" = "$2:$3" ]; [ -w "$1" ] && [ -x "$1" ]',
    'sulla-guest-chown', resolved, String(identity.uid), String(identity.gid),
  ]);
}

export function removeGuestPathAtomic(target: string): void {
  const boundedTarget = assertGuestPath(target);
  if (boundedTarget === GUEST_RUNTIME_ROOT) throw new Error('Refusing to remove the guest runtime root');
  runGuestSync([
    'sh', '-c',
    [
      'set -eu',
      '[ -e "$1" ] || exit 0',
      'resolved=$(realpath "$1")',
      'case "$resolved" in "$3"/*) ;; *) exit 73;; esac',
      '[ "$resolved" != "$3" ]',
      'parent=$(dirname "$resolved")',
      'tombstone="$parent/.$(basename "$resolved").deleting-$2"',
      'mv -- "$resolved" "$tombstone"',
      'rm -rf -- "$tombstone"',
    ].join('; '),
    'sulla-guest-remove', boundedTarget, crypto.randomUUID(), GUEST_RUNTIME_ROOT,
  ]);
}

function spawnCapture(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`${ command } timed out`));
    }, timeoutMs);
    timer.unref();
    proc.stdout.on('data', chunk => { stdout = boundedAppend(stdout, chunk) });
    proc.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk) });
    proc.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(safeErrorText(stderr) || `${ command } exited ${ code }`));
    });
  });
}

async function pipeToGuest(
  sourceCommand: string,
  sourceArgs: string[],
  guestArgs: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const source = childProcess.spawn(sourceCommand, sourceArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const guest = childProcess.spawn(paths.sullaRuntime, ['exec', '--', ...guestArgs], {
      env:   guestEnvironment(),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let sourceError = '';
    let guestError = '';
    let sourceCode: number | null = null;
    let guestCode: number | null = null;
    let settled = false;
    const stop = () => {
      source.stdout.unpipe(guest.stdin);
      if (source.exitCode === null) source.kill('SIGKILL');
      if (guest.exitCode === null) guest.kill('SIGKILL');
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error(message));
    };
    const finish = () => {
      if (settled || sourceCode === null || guestCode === null) return;
      settled = true;
      clearTimeout(timer);
      if (sourceCode === 0 && guestCode === 0) resolve();
      else reject(new Error(
        safeErrorText(guestError) || safeErrorText(sourceError) || `Guest transfer failed (${ sourceCode }/${ guestCode })`,
      ));
    };
    const timer = setTimeout(() => fail('Guest transfer timed out'), TRANSFER_TIMEOUT_MS);
    timer.unref();
    source.stderr.on('data', chunk => { sourceError = boundedAppend(sourceError, chunk) });
    guest.stderr.on('data', chunk => { guestError = boundedAppend(guestError, chunk) });
    guest.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        if (source.exitCode === null) source.kill('SIGKILL');
        return;
      }
      fail('Guest transfer input failed');
    });
    source.once('error', () => fail('Guest transfer source failed to start'));
    guest.once('error', () => fail('Guest transfer destination failed to start'));
    source.once('close', code => { sourceCode = code ?? 1; finish() });
    guest.once('close', code => {
      guestCode = code ?? 1;
      if (guestCode !== 0 && source.exitCode === null) source.kill('SIGKILL');
      finish();
    });
    source.stdout.pipe(guest.stdin);
  });
}

export async function seedGitWorktreeIntoGuest(source: string, jobKey: string): Promise<string> {
  const expectedRoot = '/mnt/worktrees';
  const resolved = fs.realpathSync(source);
  const allowedRoot = fs.realpathSync(expectedRoot);
  if ((!resolved.startsWith(`${ allowedRoot }${ path.sep }`) && resolved !== allowedRoot) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Container workspacePath must be an existing worktree under /mnt/worktrees');
  }
  const git = (...args: string[]) => spawnCapture('git', ['-C', resolved, ...args]);
  const [top, commonGitDir, head, branch, remoteUrl, dirty] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    git('rev-parse', 'HEAD'),
    git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
    git('remote', 'get-url', 'origin').catch(() => ''),
    git('status', '--porcelain=v1', '--untracked-files=normal'),
  ]);
  if (dirty) throw new Error('Container workspacePath must be clean before guest transport; commit or preserve every source change first');
  if (fs.realpathSync(top) !== resolved) throw new Error('container workspacePath must be a Git worktree root');
  if (/[^\x20-\x7e]/.test(branch) || /[\0\r\n]/.test(remoteUrl)) throw new Error('Container workspacePath has invalid Git metadata');
  let parsed: URL | undefined;
  try { parsed = new URL(remoteUrl) } catch { /* scp-style SSH remote or absent */ }
  if (parsed?.username || parsed?.password) throw new Error('Refusing to transport a Git remote containing credentials');
  if (branch && await git('rev-parse', `refs/heads/${ branch }`) !== head) {
    throw new Error('Container workspacePath branch moved while preparing guest transport');
  }
  const sourceRemoteHead = branch
    ? await git('rev-parse', `refs/remotes/origin/${ branch }`).catch(() => '')
    : '';

  const repository = path.basename(path.dirname(commonGitDir));
  const prefix = `${ repository }-${ branch || `detached-${ head.slice(0, 12) }` }-${ jobKey }-`;
  const checkout = createGuestRuntimeDirectory(GUEST_AGENT_WORKSPACES_ROOT, prefix);
  const bundle = assertGuestPath(`${ checkout }.bundle-${ crypto.randomUUID() }`, [GUEST_AGENT_WORKSPACES_ROOT]);
  const approvedRef = branch ? `refs/heads/${ branch }` : 'HEAD';
  try {
    await pipeToGuest('git', ['-C', resolved, 'bundle', 'create', '-', approvedRef], [
      'sh', '-c',
      [
        'set -eu',
        'umask 077',
        'cat > "$1"',
        'git clone --no-local "$1" "$2" >/dev/null 2>&1',
        'git -C "$2" checkout --detach "$4" >/dev/null 2>&1',
        '[ "$(git -C "$2" rev-parse HEAD)" = "$4" ]',
        'if [ -n "$3" ]; then git -C "$2" checkout -B "$3" "$4" >/dev/null 2>&1; fi',
        'if [ -n "$5" ]; then git -C "$2" remote set-url origin "$5"; fi',
        'if [ -n "$3" ]; then if [ -n "$6" ]; then git -C "$2" update-ref "refs/remotes/origin/$3" "$6"; else git -C "$2" update-ref -d "refs/remotes/origin/$3"; fi; fi',
        'rm -f -- "$1"',
      ].join('; '),
      'sulla-git-seed', bundle, checkout, branch, head, remoteUrl, sourceRemoteHead,
    ]);
    return checkout;
  } catch (error) {
    try { removeGuestPathAtomic(checkout) } catch { /* retain original failure */ }
    try { removeGuestPathAtomic(bundle) } catch { /* already absent */ }
    throw error;
  }
}

export function inspectGuestWorkspaceForCleanup(workspacePath: string): GuestWorkspaceCleanupDecision {
  existingGuestPath(workspacePath, [GUEST_AGENT_WORKSPACES_ROOT]);
  // A guest-controlled origin-tracking ref is not proof of remote publication.
  // Git status also omits ignored files that may contain irreplaceable output.
  // Retain runtime work until its owner verifies publication and preservation
  // independently; the caller returns this path in the cleanup receipt.
  return {
    remove: false,
    reason: 'workspace retained pending independent publication and file-preservation verification',
  };
}

export async function seedDirectoryIntoGuest(source: string, parent: string, prefix: string): Promise<string> {
  const resolved = fs.realpathSync(source);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Guest seed source is not a directory: ${ source }`);
  const target = createGuestRuntimeDirectory(parent, prefix);
  try {
    await pipeToGuest('tar', ['-C', resolved, '-cf', '-', '.'], [
      'sh', '-c', 'set -eu; target=$(realpath "$1"); case "$target" in "$2"/*) ;; *) exit 73;; esac; tar -C "$target" -xf -',
      'sulla-directory-seed', target, GUEST_RUNTIME_ROOT,
    ]);
    return target;
  } catch (error) {
    try { removeGuestPathAtomic(target) } catch { /* retain original failure */ }
    throw error;
  }
}
