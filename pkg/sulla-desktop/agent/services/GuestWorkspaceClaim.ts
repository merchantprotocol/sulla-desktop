// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import {
  GUEST_AGENT_WORKSPACES_ROOT,
  GUEST_CONVERSATIONS_ROOT,
  GUEST_RUNTIME_ROOT,
  runGuest,
} from './GuestRuntimeTransport';

export const GUEST_WORKSPACE_CLAIM_ROOT = `${ GUEST_RUNTIME_ROOT }/.storage-cleanup-claims`;

/**
 * Shared guest claim protocol. Launches are shared holders; confirmed cleanup
 * is the only exclusive holder. All claim-directory changes happen under one
 * kernel flock mutex, so check-and-reclaim is atomic across processes.
 *
 * Owner liveness:
 * - cleanup: a kernel flock held by the live cleanup helper process. A
 *   SIGKILLed helper, VM stop or app crash releases it, and the next claimant
 *   reclaims the marker. A live helper is never reclaimed.
 * - launch: a holder file naming the Desktop main-process instance, its token
 *   and its agent container. The current instance's holders are live while the
 *   in-process claim is held. A prior instance's holder stays live while its
 *   container exists, and is reclaimed only once the container is provably gone.
 */
export const GUEST_CLAIM_PROTOCOL = String.raw`
import errno, fcntl, hashlib, json, os, re, stat, time

def claim_key(workspace):
    return hashlib.sha256(os.path.normpath(workspace).encode()).hexdigest()

def claim_root_ready(claims_root):
    os.makedirs(claims_root, mode=0o700, exist_ok=True)
    info = os.lstat(claims_root)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Workspace claim root is not a safe directory")

def claim_mutex(claims_root, wait_seconds):
    claim_root_ready(claims_root)
    fd = os.open(os.path.join(claims_root, ".mutex"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError as exc:
            if exc.errno not in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                os.close(fd)
                raise
        if time.monotonic() >= deadline:
            os.close(fd)
            return None
        time.sleep(0.05)

def claim_directory(claims_root, key, create):
    if not re.fullmatch(r"[0-9a-f]{64}", key):
        raise RuntimeError("Invalid workspace claim key")
    directory = os.path.join(claims_root, key)
    if create:
        try:
            os.mkdir(directory, mode=0o700)
        except FileExistsError:
            pass
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Workspace claim is not a safe directory")
    return directory

def cleanup_lock_state(directory):
    # Caller holds the mutex. Probing with flock never steals a live lock.
    try:
        fd = os.open(os.path.join(directory, "cleanup.lock"), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return "none"
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                return "live"
            raise
        return "stale"
    finally:
        os.close(fd)

def remove_cleanup_marker(directory):
    for name in ("cleanup.json", "cleanup.lock"):
        try:
            os.unlink(os.path.join(directory, name))
        except FileNotFoundError:
            pass

def remove_if_empty(directory):
    try:
        os.rmdir(directory)
    except OSError:
        pass

def launch_holder_name(token):
    if not re.fullmatch(r"[0-9a-f-]{36}", token):
        raise RuntimeError("Invalid workspace claim token")
    return "launch-" + token + ".json"

def read_launch_holder(directory, name):
    fd = os.open(os.path.join(directory, name), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
            return None
        value = json.loads(os.read(fd, 4096).decode("utf-8"))
        return value if isinstance(value, dict) else None
    except ValueError:
        return None
    finally:
        os.close(fd)

def acquire_launch(claims_root, workspace, token, instance, container, sequence, wait_seconds):
    # 0 acquired, 75 cleanup holds the workspace (caller may wait and retry).
    mutex = claim_mutex(claims_root, wait_seconds)
    if mutex is None:
        return 75
    try:
        directory = claim_directory(claims_root, claim_key(workspace), True)
        state = cleanup_lock_state(directory)
        if state == "live":
            return 75
        if state == "stale":
            remove_cleanup_marker(directory)
        name = launch_holder_name(token)
        target = os.path.join(directory, name)
        if os.path.lexists(target):
            holder = read_launch_holder(directory, name)
            if holder is None or holder.get("token") != token:
                raise RuntimeError("Workspace launch holder is corrupt")
            return 0
        temporary = os.path.join(directory, "." + name + ".next")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, json.dumps({"kind": "launch", "token": token, "instance": instance,
                "container": container, "sequence": sequence, "workspace": os.path.normpath(workspace),
                "createdAt": time.time()}).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(temporary, target)
        return 0
    finally:
        os.close(mutex)

def release_launch(claims_root, workspace, token):
    mutex = claim_mutex(claims_root, 30)
    if mutex is None:
        return 75
    try:
        directory = claim_directory(claims_root, claim_key(workspace), False)
        if directory is None:
            return 0
        try:
            os.unlink(os.path.join(directory, launch_holder_name(token)))
        except FileNotFoundError:
            pass
        remove_if_empty(directory)
        return 0
    finally:
        os.close(mutex)

def acquire_cleanup(claims_root, workspace, instance, live_tokens, snapshot_sequence, container_names):
    # Returns (lock_fd, None) or (None, reason). The current instance's holder is
    # dead only if it was registered before the host snapshot and has since been
    # released in-process. container_names is None when the container runtime
    # could not be inventoried; prior-instance owners are then treated as alive.
    mutex = claim_mutex(claims_root, 15)
    if mutex is None:
        return None, "Workspace claims are busy; cleanup retained the workspace"
    try:
        directory = claim_directory(claims_root, claim_key(workspace), True)
        state = cleanup_lock_state(directory)
        if state == "live":
            return None, "Another cleanup currently owns this workspace"
        # No live cleanup exists: any marker left by a killed helper is stale.
        remove_cleanup_marker(directory)
        live = []
        for entry in sorted(os.listdir(directory)):
            if entry.startswith("."):
                continue
            if not (entry.startswith("launch-") and entry.endswith(".json")):
                live.append(entry)
                continue
            holder = read_launch_holder(directory, entry)
            if holder is None:
                live.append(entry)
            elif holder.get("instance") == instance:
                sequence = holder.get("sequence")
                if holder.get("token") in live_tokens or not isinstance(sequence, int) or sequence > snapshot_sequence:
                    live.append(entry)
                else:
                    os.unlink(os.path.join(directory, entry))
            elif container_names is None or not holder.get("container") or holder.get("container") in container_names:
                live.append(entry)
            else:
                os.unlink(os.path.join(directory, entry))
        if live:
            return None, "A running, paused or recovering agent launch owns this workspace"
        lock_path = os.path.join(directory, "cleanup.lock")
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        owner = os.open(os.path.join(directory, "cleanup.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            os.write(owner, json.dumps({"kind": "cleanup", "pid": os.getpid(), "instance": instance, "createdAt": time.time()}).encode())
        finally:
            os.close(owner)
        return lock_fd, None
    finally:
        os.close(mutex)

def release_cleanup(claims_root, workspace, lock_fd):
    mutex = claim_mutex(claims_root, 30)
    try:
        if mutex is not None:
            directory = claim_directory(claims_root, claim_key(workspace), False)
            if directory is not None:
                remove_cleanup_marker(directory)
                remove_if_empty(directory)
    finally:
        os.close(lock_fd)
        if mutex is not None:
            os.close(mutex)
`;

const CLAIM_SCRIPT = `${ GUEST_CLAIM_PROTOCOL }
import sys
request = json.loads(sys.argv[1])
workspace = os.path.normpath(request["workspace"])
if not any(workspace == item or workspace.startswith(item + os.sep) for item in request["roots"]):
    raise SystemExit(73)
if request["action"] == "acquire":
    raise SystemExit(acquire_launch(request["claimsRoot"], workspace, request["token"], request["instance"], request["container"], int(request["sequence"]), 5))
if request["action"] == "release":
    raise SystemExit(release_launch(request["claimsRoot"], workspace, request["token"]))
raise SystemExit(64)
`;

/** Identity of this Desktop main process; Electron's single-instance lock makes it unique per guest. */
export const WORKSPACE_CLAIM_INSTANCE = crypto.randomUUID();

const liveClaims = new Map<string, Map<string, number>>();
let claimSequence = 0;

export interface WorkspaceClaimSnapshot {
  instance:   string;
  liveTokens: string[];
  sequence:   number;
}

export interface GuestWorkspaceClaim {
  release():Promise<void>;
}

export type GuestClaimRunner = (args:string[], input?:string | Buffer, timeoutMs?:number) => Promise<string>;

export interface GuestWorkspaceClaimOptions {
  runner?:     GuestClaimRunner;
  claimsRoot?: string;
  roots?:      string[];
  instance?:   string;
  /** Bounded wait while a confirmed cleanup holds the workspace. */
  waitMs?:     number;
  sleep?:      (ms:number) => Promise<void>;
}

export function guestWorkspaceClaimId(workspacePath:string):string {
  return crypto.createHash('sha256').update(workspacePath.replace(/\/+$/, '')).digest('hex');
}

/** Launch claims this process holds for one workspace, as of the returned sequence. */
export function liveWorkspaceClaimSnapshot(workspacePath:string, instance = WORKSPACE_CLAIM_INSTANCE):WorkspaceClaimSnapshot {
  return { instance, liveTokens: [...liveClaims.get(guestWorkspaceClaimId(workspacePath))?.keys() ?? []], sequence: claimSequence };
}

function exitCode(error:unknown):number | undefined {
  const value = (error as { exitCode?: unknown; code?: unknown })?.exitCode ?? (error as { code?: unknown })?.code;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Shared launch/use claim. Concurrent launches of one workspace coexist; a
 * confirmed cleanup excludes them. A launch that finds cleanup in progress
 * waits within a bounded window instead of failing the chat turn.
 */
export async function claimGuestWorkspace(workspacePath:string, container:string, options:GuestWorkspaceClaimOptions = {}):Promise<GuestWorkspaceClaim> {
  const roots = options.roots ?? [GUEST_AGENT_WORKSPACES_ROOT, GUEST_CONVERSATIONS_ROOT];
  const normalized = workspacePath.replace(/\/+$/, '');
  if (!roots.some(root => normalized === root || normalized.startsWith(`${ root }/`))) {
    throw new Error('Workspace claim escaped the guest runtime roots');
  }
  const runner = options.runner ?? runGuest;
  const sleep = options.sleep ?? ((ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const key = guestWorkspaceClaimId(normalized);
  const token = crypto.randomUUID();
  const sequence = ++claimSequence;
  const request = (action:'acquire' | 'release') => JSON.stringify({
    action,
    workspace:  normalized,
    token,
    container,
    sequence,
    instance:   options.instance ?? WORKSPACE_CLAIM_INSTANCE,
    claimsRoot: options.claimsRoot ?? GUEST_WORKSPACE_CLAIM_ROOT,
    roots,
  });
  const deadline = Date.now() + (options.waitMs ?? 120_000);
  // Register before acquiring: a cleanup that observes this holder must see it as live.
  const tokens = liveClaims.get(key) ?? new Map<string, number>();
  tokens.set(token, sequence);
  liveClaims.set(key, tokens);
  const forget = () => {
    tokens.delete(token);
    if (!tokens.size && liveClaims.get(key) === tokens) liveClaims.delete(key);
  };
  for (let delay = 500; ; delay = Math.min(delay * 2, 5_000)) {
    try {
      // The same token makes a transport retry of a completed acquire idempotent.
      await runner(['python3', '-c', CLAIM_SCRIPT, request('acquire')]);
      break;
    } catch (error) {
      if (exitCode(error) !== 75 || Date.now() + delay > deadline) {
        forget();
        throw new Error(exitCode(error) === 75
          ? 'Workspace cleanup is still in progress; try again shortly'
          : `Workspace claim could not be acquired: ${ (error as Error)?.message ?? error }`);
      }
      await sleep(delay);
    }
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      // The owner has ended either way; a leftover holder file is reclaimable.
      forget();
      await runner(['python3', '-c', CLAIM_SCRIPT, request('release')]);
    },
  };
}
