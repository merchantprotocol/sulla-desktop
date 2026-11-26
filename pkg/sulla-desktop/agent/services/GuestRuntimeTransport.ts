// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { sullaRuntimeGuestUser } from '@pkg/backend/sullaRuntime/state';
import paths from '@pkg/utils/paths';

import { GuestCommandRunner, type GuestExecFile } from './GuestCommandRunner';
import { GuestDiskFullError } from './GuestDiskFullError';
import { GuestWorkspaceCleanupInspector, type GuestWorkspaceCleanupDecision } from './GuestWorkspaceCleanupInspector';

export const GUEST_RUNTIME_ROOT = '/mnt/data/sulla/runtime';
export const GUEST_AGENT_WORKSPACES_ROOT = `${ GUEST_RUNTIME_ROOT }/agents`;
export const GUEST_PROVIDER_FILES_ROOT = `${ GUEST_RUNTIME_ROOT }/provider-transport`;
export const GUEST_CONVERSATIONS_ROOT = `${ GUEST_RUNTIME_ROOT }/conversations`;

const GUEST_PATH_ROOTS = [GUEST_RUNTIME_ROOT, '/dev/shm/sulla-agent-secrets'];
const CAPTURE_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_DISK_RESERVE_KIB = 1024 * 1024;

export interface GuestRuntimeIdentity {
  uid: number;
  gid: number;
}

export type { GuestWorkspaceCleanupDecision };

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

const guestCommands = new GuestCommandRunner({
  runtimeBinary: () => paths.sullaRuntime,
  execFile:      childProcess.execFile as GuestExecFile,
  environment:   guestEnvironment,
  redact:        safeErrorText,
  warn:          message => console.warn(message),
});

export function runGuest(args: string[], input?: string | Buffer, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  return guestCommands.run(args, input, timeoutMs);
}

let guestIdentity: { user: string; identity: GuestRuntimeIdentity } | undefined;

/** The container runs as the actual guest login identity, never a host-derived or guessed UID. */
export async function getGuestRuntimeIdentity(): Promise<GuestRuntimeIdentity> {
  // Guest commands run as root on the Sulla runtime; there the login account
  // is the one the runtime created for this Mac user, looked up by name.
  const runtimeUser = sullaRuntimeGuestUser()?.name ?? '';
  if (guestIdentity?.user === runtimeUser) return guestIdentity.identity;
  const output = runtimeUser
    ? await runGuest(['sh', '-c', 'set -eu; id -u "$1"; id -g "$1"', 'sulla-guest-id', runtimeUser])
    : await runGuest(['sh', '-c', 'set -eu; id -u; id -g']);
  const [uid, gid] = output.split(/\s+/).map(Number);
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Could not resolve the Sulla guest runtime identity');
  }
  guestIdentity = { user: runtimeUser, identity: { uid, gid } };
  return guestIdentity.identity;
}

async function existingGuestPath(target: string, roots = GUEST_PATH_ROOTS): Promise<string> {
  const boundedTarget = assertGuestPath(target, roots);
  const resolved = await runGuest([
    'sh', '-c',
    'set -eu; resolved=$(realpath "$1"); case "$resolved" in "$2"|"$2"/*) printf "%s" "$resolved";; *) exit 73;; esac',
    'sulla-guest-path', boundedTarget, roots[0],
  ]);
  return assertGuestPath(resolved, roots);
}

export async function createGuestRuntimeDirectory(parent: string, prefix: string): Promise<string> {
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80) || 'runtime-';
  const { uid, gid } = await getGuestRuntimeIdentity();
  const created = await runGuest([
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
  return await existingGuestPath(created, [boundedParent]);
}

/** Create or reopen one stable, guest-owned runtime directory. */
export async function ensureGuestRuntimeDirectory(parent: string, name: string): Promise<string> {
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(name)) throw new Error('Invalid stable guest runtime directory name');
  const { uid, gid } = await getGuestRuntimeIdentity();
  const target = assertGuestPath(path.posix.join(boundedParent, name), [boundedParent]);
  await runGuest([
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
  return await existingGuestPath(target, [boundedParent]);
}

/** Create or reopen a validated directory tree in one guest runtime round trip. */
export async function ensureGuestRuntimeDirectories(parent: string, relativeNames: string[]): Promise<string[]> {
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  const targets = relativeNames.map(name => {
    const segments = name.split('/');
    if (segments.length === 0 || segments.some(segment => !/^[a-zA-Z0-9_.-]{1,120}$/.test(segment))) {
      throw new Error('Invalid stable guest runtime directory name');
    }
    return assertGuestPath(path.posix.join(boundedParent, ...segments), [boundedParent]);
  });
  const { uid, gid } = await getGuestRuntimeIdentity();
  await runGuest([
    'sh', '-c',
    [
      'set -eu', 'umask 077',
      'parent="$1"; uid="$2"; gid="$3"; root="$4"; shift 4',
      '[ "$(realpath -m "$parent")" = "$parent" ]',
      'sudo install -d -m 0700 -o "$uid" -g "$gid" "$parent"',
      '[ "$(realpath "$parent")" = "$parent" ]',
      'case "$parent" in "$root"|"$root"/*) ;; *) exit 73;; esac',
      [
        'for target; do',
        'case "$target" in "$parent"/*) ;; *) exit 73;; esac',
        '[ "$(realpath -m "$target")" = "$target" ]',
        'sudo install -d -m 0700 -o "$uid" -g "$gid" "$target"',
        '[ "$(realpath "$target")" = "$target" ]',
        '[ "$(stat -c %u:%g "$target")" = "$uid:$gid" ]',
        'done',
      ].join('\n'),
    ].join('; '),
    'sulla-stable-guest-mkdirs', boundedParent, String(uid), String(gid), GUEST_RUNTIME_ROOT, ...targets,
  ]);
  return targets;
}

/** Prepare the private scratch directory without changing an existing worktree root. */
export async function ensureGuestWorktreeDirectories(identity: GuestRuntimeIdentity): Promise<void> {
  if (![identity.uid, identity.gid].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid guest worktree ownership');
  }
  await runGuest([
    'python3', '-c',
    [
      'import os, stat, sys',
      'root, uid, gid = sys.argv[1:]',
      'uid, gid = int(uid), int(gid)',
      'try: os.mkdir(root, 0o755)',
      'except FileExistsError: pass',
      'flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW',
      'root_fd = os.open(root, flags)',
      'try: os.mkdir("_scratch", 0o700, dir_fd=root_fd)',
      'except FileExistsError: pass',
      'scratch_fd = os.open("_scratch", flags, dir_fd=root_fd)',
      'info = os.fstat(scratch_fd)',
      'if (info.st_uid, info.st_gid) != (uid, gid): os.fchown(scratch_fd, uid, gid)',
      'if stat.S_IMODE(info.st_mode) != 0o700: os.fchmod(scratch_fd, 0o700)',
    ].join('\n'), '/mnt/worktrees', String(identity.uid), String(identity.gid),
  ]);
}

/**
 * Initialize a stable conversation workspace from a clean VM worktree once.
 * The marker lives inside .git, so it never dirties the worker checkout. The
 * staged clone and marker move into place together; a crash cannot publish a
 * half-cloned workspace as resumable.
 */
export async function seedGitWorktreeIntoStableGuest(source: string, target: string, existingJobKey?: string): Promise<string> {
  const normalizedSource = path.posix.resolve(source);
  if (normalizedSource !== '/mnt/worktrees' && !normalizedSource.startsWith('/mnt/worktrees/')) {
    throw new Error('Container workspacePath must be an existing worktree under /mnt/worktrees');
  }
  const boundedTarget = assertGuestPath(target, [GUEST_CONVERSATIONS_ROOT]);
  if (existingJobKey && !/^[a-zA-Z0-9_.-]+$/.test(existingJobKey)) throw new Error('Invalid existing worktree job key');
  const workspace = await runGuest([
    'python3', '-c',
    [
      'import fcntl, os, sys',
      'root, command, *args = sys.argv[1:]',
      'fd = os.open(root + "/.workspace-seed.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)',
      'fcntl.flock(fd, fcntl.LOCK_EX)',
      'os.set_inheritable(fd, True)',
      'os.execvp("sh", ["sh", "-c", command, *args])',
    ].join('\n'), GUEST_CONVERSATIONS_ROOT,
    [
      'set -eu',
      'umask 077',
      'source_input="$1"; target="$2"; root="$3"; reserve_kib="$4"; legacy_root="$5"; legacy_key="$6"',
      'case "$target" in "$root"/*/workspace) ;; *) exit 73;; esac',
      '[ -d "$target" ] && [ "$(realpath "$target")" = "$target" ]',
      'marker="$target/.git/sulla-workspace-binding"',
      'if [ -f "$marker" ]; then [ "$(realpath "$marker")" = "$marker" ] && [ "$(sed -n "1p" "$marker")" = "$source_input" ] || { echo "stable workspace belongs to another seed" >&2; exit 74; }; git -c safe.directory="$target" -C "$target" rev-parse --is-inside-work-tree >/dev/null; printf "%s" "$target"; exit 0; fi',
      'if [ -n "$legacy_key" ] && [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then [ -e "$target/.git" ] && git -c safe.directory="$target" -C "$target" rev-parse --is-inside-work-tree >/dev/null || { echo "refusing an unbound non-Git stable workspace" >&2; exit 76; }; printf "%s" "$target"; exit 0; fi',
      '[ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo "refusing to replace a nonempty unbound stable workspace" >&2; exit 76; }',
      'source=$(realpath "$source_input")',
      'case "$source" in /mnt/worktrees/*) ;; *) exit 73;; esac',
      '[ -d "$source" ] && [ ! -L "$source_input" ]',
      'git_source() { git -c safe.directory="$source" -C "$source" "$@"; }',
      '[ "$(realpath "$(git_source rev-parse --show-toplevel)")" = "$source" ]',
      'head=$(git_source rev-parse HEAD)',
      'branch=$(git_source symbolic-ref --quiet --short HEAD || true)',
      'remote=$(git_source remote get-url origin 2>/dev/null || true)',
      'case "$remote" in *://*@*|http*://*[?#]*) echo "refusing a Git remote containing credentials" >&2; exit 78;; esac',
      'remote_head=""; if [ -n "$branch" ]; then [ "$(git_source rev-parse "refs/heads/$branch")" = "$head" ]; remote_head=$(git_source rev-parse --verify "refs/remotes/origin/$branch" 2>/dev/null || true); fi',
      'common=$(git_source rev-parse --path-format=absolute --git-common-dir); repository=$(basename "$(dirname "$common")"); common=$(realpath "$common")',
      'case "$common" in /mnt/worktrees/*) ;; *) exit 73;; esac',
      [
        'if [ -n "$legacy_key" ]; then',
        '# Reproduce the old checkout prefix, including the mktemp prefix limit.',
        'prefix=$(printf "%s-%s-%s-" "$repository" "${branch:-detached-$(printf %.12s "$head")}" "$legacy_key" | LC_ALL=C sed \'s/[^a-zA-Z0-9_.-]/-/g\')',
        'legacy_prefix=$(printf %.80s "$prefix")',
        'unsafe_checkout() { echo "could not identify a single safe retained checkout for the interrupted task" >&2; exit 74; }',
        'set -- "$legacy_root/$legacy_prefix"????????',
        'if [ -e "$1" ] || [ -L "$1" ]; then',
        '[ "$#" -eq 1 ] && [ "$prefix" = "$legacy_prefix" ] || unsafe_checkout',
        'checkout="$1"; suffix=${checkout#"$legacy_root/$legacy_prefix"}',
        'case "$suffix" in *[!A-Za-z0-9]*) unsafe_checkout;; esac',
        '[ -d "$checkout/.git" ] && [ "$(realpath "$checkout/.git")" = "$checkout/.git" ] || unsafe_checkout',
        'git_legacy() { git -c safe.directory="$checkout" -C "$checkout" "$@"; }',
        '[ "$(git_legacy rev-parse --show-toplevel)" = "$checkout" ] && git_legacy merge-base --is-ancestor "$head" HEAD || unsafe_checkout',
        'legacy_remote=$(git_legacy remote get-url origin 2>/dev/null || true)',
        'if [ "$legacy_remote" != "$remote" ]; then',
        'case "$legacy_remote" in "$checkout".bundle-????????-????-????-????-????????????) [ -z "$remote" ] || unsafe_checkout;; *) unsafe_checkout;; esac',
        'fi',
        'printf "%s" "$checkout"; exit 0;',
        'fi',
        'fi',
      ].join('\n'),
      '[ -z "$(git_source status --porcelain=v1 --untracked-files=normal)" ] || { echo "container workspacePath must be clean before guest transport" >&2; exit 77; }',
      'stage="$(dirname "$target")/.workspace-initializing"',
      'rm -rf -- "$stage"',
      'trap \'rm -rf -- "$stage"\' EXIT',
      'trap \'exit 75\' INT TERM',
      'workspace_size=$(du -sk "$source") && workspace_size=${workspace_size%%[!0-9]*}',
      'git_size=$(du -sk "$common") && git_size=${git_size%%[!0-9]*}',
      'disk=$(df -Pk "$target"); free=$(printf "%s\\n" "$disk" | awk \'NR == 2 {print $4}\')',
      '[ -n "$workspace_size" ] && [ -n "$git_size" ] && [ -n "$free" ]',
      '[ "$free" -ge "$((reserve_kib + workspace_size + git_size))" ] || { echo "no space left on device for a durable workspace and VM reserve" >&2; exit 79; }',
      'git clone --no-local "$source" "$stage" >/dev/null 2>&1',
      'git -C "$stage" checkout --detach "$head" >/dev/null 2>&1',
      '[ "$(git -C "$stage" rev-parse HEAD)" = "$head" ]',
      'if [ -n "$branch" ]; then git -C "$stage" checkout -B "$branch" "$head" >/dev/null 2>&1; fi',
      'if [ -n "$remote" ]; then git -C "$stage" remote set-url origin "$remote"; else git -C "$stage" remote remove origin 2>/dev/null || true; fi',
      'if [ -n "$branch" ]; then if [ -n "$remote_head" ]; then git -C "$stage" update-ref "refs/remotes/origin/$branch" "$remote_head"; else git -C "$stage" update-ref -d "refs/remotes/origin/$branch"; fi; fi',
      'printf "%s\\n%s\\n" "$source_input" "$head" > "$stage/.git/sulla-workspace-binding"',
      'python3 -c \'import os, sys; os.replace(sys.argv[1], sys.argv[2])\' "$stage" "$target"',
      'trap - EXIT INT TERM',
      'printf "%s" "$target"',
    ].join('; '),
    'sulla-stable-workspace-seed', normalizedSource, boundedTarget, GUEST_CONVERSATIONS_ROOT, String(WORKSPACE_DISK_RESERVE_KIB),
    GUEST_AGENT_WORKSPACES_ROOT, existingJobKey ?? '',
  ], undefined, TRANSFER_TIMEOUT_MS);
  return await existingGuestPath(workspace, [workspace === boundedTarget ? GUEST_CONVERSATIONS_ROOT : GUEST_AGENT_WORKSPACES_ROOT]);
}

export async function writeGuestFileAtomic(target: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const boundedTarget = assertGuestPath(target);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid guest file mode');
  await runGuest([
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

export async function chmodGuestPath(target: string, mode: number): Promise<void> {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid guest path mode');
  const resolved = await existingGuestPath(target);
  await runGuest(['chmod', mode.toString(8), '--', resolved]);
}

export async function chownGuestPath(target: string, identity: GuestRuntimeIdentity): Promise<void> {
  await chownGuestPaths([target], identity);
}

/** Validate and chown several bounded guest paths in one runtime round trip. */
export async function chownGuestPaths(targets: string[], identity: GuestRuntimeIdentity): Promise<void> {
  if (![identity.uid, identity.gid].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid guest path ownership');
  }
  const boundedTargets = targets.map(target => assertGuestPath(target));
  if (boundedTargets.length === 0) return;
  await runGuest([
    'sh', '-c',
    [
      'set -eu',
      'uid="$1"; gid="$2"; root="$3"; shift 3',
      [
        'for target; do',
        'resolved=$(realpath "$target")',
        'case "$resolved" in "$root"|"$root"/*) ;; *) exit 73;; esac',
        'sudo chown -hR "$uid:$gid" -- "$resolved"',
        '[ "$(stat -c %u:%g "$resolved")" = "$uid:$gid" ]',
        '[ -w "$resolved" ] && [ -x "$resolved" ]',
        'done',
      ].join('\n'),
    ].join('; '),
    'sulla-guest-chown', String(identity.uid), String(identity.gid), GUEST_RUNTIME_ROOT, ...boundedTargets,
  ]);
}

export async function removeGuestPathAtomic(target: string): Promise<void> {
  const boundedTarget = assertGuestPath(target);
  if (boundedTarget === GUEST_RUNTIME_ROOT) throw new Error('Refusing to remove the guest runtime root');
  await runGuest([
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
      else reject(GuestDiskFullError.fromGuestFailure(
        safeErrorText(guestError) || safeErrorText(sourceError), `Guest transfer failed (${ sourceCode }/${ guestCode })`,
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
  const checkout = await createGuestRuntimeDirectory(GUEST_AGENT_WORKSPACES_ROOT, prefix);
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
    try { await removeGuestPathAtomic(checkout) } catch { /* retain original failure */ }
    try { await removeGuestPathAtomic(bundle) } catch { /* already absent */ }
    throw error;
  }
}

const workspaceCleanup = new GuestWorkspaceCleanupInspector({
  ephemeralRoot:  GUEST_AGENT_WORKSPACES_ROOT,
  persistentRoot: GUEST_CONVERSATIONS_ROOT,
  run:            args => runGuest(args),
});

export async function inspectGuestWorkspaceForCleanup(workspacePath: string): Promise<GuestWorkspaceCleanupDecision> {
  return await workspaceCleanup.inspect(workspacePath);
}

const contentAddressedSeeds = new Map<string, Promise<string>>();
const directoryDigests = new Map<string, string>();

function hashDirectoryTree(root: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (directory: string, relative = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const childRelative = path.posix.join(relative, name);
      const stat = fs.lstatSync(absolute);
      hash.update(`${ childRelative }\0${ stat.mode }\0`);
      if (stat.isDirectory()) visit(absolute, childRelative);
      else if (stat.isSymbolicLink()) hash.update(`link\0${ fs.readlinkSync(absolute) }\0`);
      else if (stat.isFile()) hash.update(fs.readFileSync(absolute));
      else throw new Error(`Guest seed source contains unsupported entry: ${ absolute }`);
    }
  };
  visit(root);
  const digest = hash.digest('hex');
  directoryDigests.set(root, digest);
  return digest;
}

/**
 * Seed immutable directory content once per digest and reuse it across containers.
 * The caller must mount the returned guest directory read-only; shared seeds are
 * intentionally not lifecycle cleanup paths.
 */
export async function seedContentAddressedDirectoryIntoGuest(source: string, parent: string, label: string): Promise<string> {
  const resolved = fs.realpathSync(source);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Guest seed source is not a directory: ${ source }`);
  const boundedParent = assertGuestPath(parent, [GUEST_RUNTIME_ROOT]);
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40) || 'seed';
  // Packaged docs are immutable for the process lifetime; hash them once per app run.
  const digest = directoryDigests.get(resolved) ?? hashDirectoryTree(resolved);
  const target = assertGuestPath(path.posix.join(boundedParent, `${ safeLabel }-${ digest }`), [boundedParent]);
  const cacheKey = `${ resolved }\0${ target }`;
  let seeded = contentAddressedSeeds.get(cacheKey);
  if (!seeded) {
    seeded = (async() => {
      const { uid, gid } = await getGuestRuntimeIdentity();
      const status = await runGuest([
        'sh', '-c',
        [
          'set -eu', 'umask 077',
          'sudo install -d -m 0700 -o "$3" -g "$4" "$1"',
          '[ "$(realpath "$1")" = "$1" ]',
          'case "$2" in "$1"/*) ;; *) exit 73;; esac',
          '[ ! -L "$2" ]',
          'if [ -f "$2/.sulla-content-digest" ] && [ "$(cat "$2/.sulla-content-digest")" = "$5" ]; then printf hit; exit 0; fi',
          'if [ -e "$2" ]; then resolved=$(realpath "$2"); [ "$resolved" = "$2" ]; case "$resolved" in "$1"/*) ;; *) exit 73;; esac; sudo rm -rf -- "$resolved"; fi',
          'sudo install -d -m 0700 -o "$3" -g "$4" "$2"',
          'printf miss',
        ].join('; '),
        'sulla-content-seed', boundedParent, target, String(uid), String(gid), digest,
      ]);
      if (status === 'miss') {
        await pipeToGuest('tar', ['-C', resolved, '-cf', '-', '.'], [
          'sh', '-c',
          [
            'set -eu',
            'target=$(realpath "$1")',
            'case "$target" in "$2"/*) ;; *) exit 73;; esac',
            'tar --no-same-owner -C "$target" -xf -',
            'sudo chown -hR "$4:$5" -- "$target"',
            'printf "%s" "$3" > "$target/.sulla-content-digest"',
            'chmod 0400 "$target/.sulla-content-digest"',
          ].join('; '),
          'sulla-content-seed-transfer', target, boundedParent, digest, String(uid), String(gid),
        ]);
      }
      return target;
    })();
    contentAddressedSeeds.set(cacheKey, seeded);
    seeded.catch(() => contentAddressedSeeds.delete(cacheKey));
  }
  return await seeded;
}

export async function seedDirectoryIntoGuest(source: string, parent: string, prefix: string): Promise<string> {
  const resolved = fs.realpathSync(source);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Guest seed source is not a directory: ${ source }`);
  const target = await createGuestRuntimeDirectory(parent, prefix);
  try {
    await pipeToGuest('tar', ['-C', resolved, '-cf', '-', '.'], [
      'sh', '-c', 'set -eu; target=$(realpath "$1"); case "$target" in "$2"/*) ;; *) exit 73;; esac; tar -C "$target" -xf -',
      'sulla-directory-seed', target, GUEST_RUNTIME_ROOT,
    ]);
    return target;
  } catch (error) {
    try { await removeGuestPathAtomic(target) } catch { /* retain original failure */ }
    throw error;
  }
}
