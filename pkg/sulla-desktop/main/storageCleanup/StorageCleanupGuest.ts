// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  GUEST_AGENT_WORKSPACES_ROOT,
  GUEST_CONVERSATIONS_ROOT,
  runGuest,
} from '@pkg/agent/services/GuestRuntimeTransport';
import {
  GUEST_CLAIM_PROTOCOL,
  GUEST_WORKSPACE_CLAIM_ROOT,
  liveWorkspaceClaimSnapshot,
  type WorkspaceClaimSnapshot,
} from '@pkg/agent/services/GuestWorkspaceClaim';

export interface GuestGitRef {
  name:      string;
  commitSha: string;
}

export interface GuestRepositoryState {
  headSha:            string | null;
  detached:           boolean;
  currentBranch:      string | null;
  localBranches:      GuestGitRef[];
  localTags:          GuestGitRef[];
  /** Non-branch/tag refs (remote-tracking, notes, original, custom) whose tips are outside branch/tag history; each needs remote proof. */
  extraRefs:          GuestGitRef[];
  /** Refs that cannot be proven (replace refs, non-commit targets); they retain the checkout. */
  unsupportedRefs:    string[];
  /** Non-sample hooks, modified samples, core.hooksPath or shell aliases: unpublished local scripts. */
  localScripts:       string[];
  refsDigest:         string;
  reflogCommits:      string[];
  reflogOnlyCommits:  string[];
  unreachableObjects: string[];
  stashCommits:       string[];
  dirtyEntries:       string[];
  ignoredEntries:     string[];
  remoteUrls:         string[];
  worktreeMetadata:   string[];
  submodules:         string[];
  nestedRepositories: string[];
  /** Full counts; list fields above are bounded samples. */
  counts:             Record<string, number>;
  fingerprint:        string;
  error?:             string;
}

export interface GuestCandidateRef {
  path:                string;
  workspaceRoot:       string;
  persistenceKeyHash?: string;
  source:              'agent' | 'conversation-child';
}

export interface GuestStorageCandidate extends GuestCandidateRef {
  allocatedBytes:   number | null;
  /** Allocated bytes whose every hard link lies inside the target; what removal can actually free. */
  recoverableBytes: number | null;
  lastActivityAt:   string | null;
  identity: {
    realPath:            string;
    device:              number;
    inode:               number;
    mode:                number;
    size:                number;
    modifiedNanoseconds: string;
    contentFingerprint:  string;
  };
  /** False when content verification was skipped because the checkout is already retained. */
  contentVerified: boolean;
  repository:      GuestRepositoryState;
  unsafeSymlinks:  string[];
  specialFiles:    string[];
  mountPoints:     string[];
  scanError?:      string;
}

export interface GuestStorageScan {
  candidates: GuestStorageCandidate[];
  errors:     string[];
}

export interface GuestDeleteRequest {
  path:           string;
  workspaceRoot:  string;
  source:         GuestStorageCandidate['source'];
  identity:       GuestStorageCandidate['identity'];
  gitFingerprint: string;
}

export interface GuestDeleteResult {
  /** partial: removal began and stopped; removedBytes counts only data whose last link was unlinked. */
  status:                   'removed' | 'partial' | 'blocked' | 'failed';
  reason?:                  string;
  removedBytes:             number;
  removedEntries?:          number;
  guestFreeSpaceDeltaBytes: number | null;
}

export type GuestRunner = (args:string[], input?:string | Buffer, timeoutMs?:number) => Promise<string>;

const FIXTURE_ROOTS = ['/tmp/sulla-storage-cleanup-tests/', '/private/tmp/sulla-storage-cleanup-tests/'];
const LIST_TIMEOUT_MS = 45_000;
const INSPECT_TIMEOUT_MS = 45_000;
const INSPECT_CONCURRENCY = 3;
const INVENTORY_BUDGET_MS = 150_000;
const DELETE_TIMEOUT_MS = 90_000;

const GUEST_STORAGE_HELPER = `${ GUEST_CLAIM_PROTOCOL }
${ String.raw`
import subprocess, sys

AGENTS = "/mnt/data/sulla/runtime/agents"
CONVERSATIONS = "/mnt/data/sulla/runtime/conversations"
CLAIMS = "/mnt/data/sulla/runtime/.storage-cleanup-claims"
MAX_SCAN_FILES = 100000
MAX_HASH_BYTES = 268435456
MAX_MEASURE_ENTRIES = 5000000
MEASURE_SECONDS = 25
VERIFY_SECONDS = 70
SAMPLE = 20
MAX_PROOF_COMMITS = 200
SKIP_NAMES = {".git", "node_modules"}
SHA = re.compile(r"[0-9a-f]{40,64}")

def bounded(path, root):
    path = os.path.normpath(path)
    return path == root or path.startswith(root + os.sep)

def run_git(root, args):
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": "/nonexistent",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
    }
    command = [
        "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "diff.external=", "-c", "interactive.diffFilter=", "-c", "protocol.file.allow=never", "-C", root,
    ] + args
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, timeout=8, check=False)
    except Exception as exc:
        return None, "git inspection failed: " + str(exc)
    if result.returncode != 0:
        return None, result.stderr.decode("utf-8", "replace")[-1000:].strip() or "git inspection failed"
    return result.stdout, None

def git_lines(root, args):
    output, error = run_git(root, args)
    if error:
        raise RuntimeError(error)
    return output.decode("utf-8", "replace").splitlines()

def git_entries(root, args):
    output, error = run_git(root, args)
    if error:
        raise RuntimeError(error)
    return [entry for entry in output.decode("utf-8", "replace").split("\0") if entry]

def resolve_commit(root, ref):
    lines = git_lines(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"])
    if len(lines) != 1 or not SHA.fullmatch(lines[0].strip()):
        raise RuntimeError("Git ref did not resolve to one commit")
    return lines[0].strip()

def digest_lines(values):
    return hashlib.sha256("\0".join(values).encode("utf-8", "replace")).hexdigest()

LIST_KEYS = ["localBranches", "localTags", "extraRefs", "unsupportedRefs", "localScripts", "reflogCommits", "reflogOnlyCommits",
    "unreachableObjects", "stashCommits", "dirtyEntries", "ignoredEntries", "remoteUrls", "worktreeMetadata",
    "submodules", "nestedRepositories"]
PROOF_KEYS = ["localBranches", "localTags", "extraRefs", "reflogOnlyCommits", "remoteUrls"]
BLOCKING_KEYS = ["unsupportedRefs", "localScripts", "unreachableObjects", "stashCommits", "dirtyEntries", "ignoredEntries",
    "worktreeMetadata", "submodules", "nestedRepositories"]

TEMPLATE_HOOKS = None

def template_hook_directory():
    # Hook samples installed by this guest's Git; clones copy them verbatim.
    global TEMPLATE_HOOKS
    if TEMPLATE_HOOKS is None:
        TEMPLATE_HOOKS = ""
        candidates = []
        output, error = run_git("/", ["--exec-path"])
        if error is None and output.strip():
            prefix = os.path.dirname(os.path.dirname(output.decode("utf-8", "replace").strip()))
            candidates.append(os.path.join(prefix, "share", "git-core", "templates", "hooks"))
        candidates.append("/usr/share/git-core/templates/hooks")
        for candidate in candidates:
            if os.path.isdir(candidate) and not os.path.islink(candidate):
                TEMPLATE_HOOKS = candidate
                break
    return TEMPLATE_HOOKS

def read_small_regular(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 262144:
            return None
        data = b""
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                return data
            data += chunk
    finally:
        os.close(fd)

def local_git_scripts(root):
    # Hooks and shell aliases live only in .git and are never pushed. They are
    # read, never executed; anything other than a pristine template sample retains the checkout.
    found = []
    hooks = os.path.join(root, ".git", "hooks")
    if os.path.lexists(hooks):
        if not stat.S_ISDIR(os.lstat(hooks).st_mode):
            found.append("hooks")
        else:
            templates = template_hook_directory()
            for entry in sorted(os.listdir(hooks)):
                if not entry.endswith(".sample"):
                    found.append("hooks/" + entry)
                    continue
                local = read_small_regular(os.path.join(hooks, entry))
                trusted = read_small_regular(os.path.join(templates, entry)) if templates else None
                if local is None or trusted is None or local != trusted:
                    found.append("hooks/" + entry + " (modified or unrecognized sample)")
    output, error = run_git(root, ["config", "--local", "--get-regexp", r"^(core\.hookspath|alias\..*)$"])
    if error is None:
        for line in output.decode("utf-8", "replace").splitlines():
            parts = line.split(None, 1)
            if parts and (parts[0].lower() == "core.hookspath" or (len(parts) == 2 and parts[1].lstrip().startswith("!"))):
                found.append("config " + parts[0])
    return sorted(value[:500] for value in found)

def repository_state(root, nested):
    state = {
        "headSha": None, "detached": False, "currentBranch": None, "localBranches": [], "localTags": [],
        "extraRefs": [], "unsupportedRefs": [], "localScripts": [], "refsDigest": "", "reflogCommits": [], "reflogOnlyCommits": [],
        "unreachableObjects": [], "stashCommits": [], "dirtyEntries": [], "ignoredEntries": [], "remoteUrls": [],
        "worktreeMetadata": [], "submodules": [], "nestedRepositories": sorted(nested),
    }
    try:
        git_entry = os.lstat(os.path.join(root, ".git"))
        if not stat.S_ISDIR(git_entry.st_mode):
            raise RuntimeError("Linked worktrees and non-directory Git metadata are retained in this release")
        common_dir = os.path.join(root, ".git", "commondir")
        if os.path.lexists(common_dir):
            state["worktreeMetadata"] = [".git/commondir"]
            raise RuntimeError("Repositories that depend on shared Git common metadata are retained in this release")
        worktrees_dir = os.path.join(root, ".git", "worktrees")
        if os.path.lexists(worktrees_dir):
            worktrees_info = os.lstat(worktrees_dir)
            if not stat.S_ISDIR(worktrees_info.st_mode):
                state["worktreeMetadata"] = [".git/worktrees"]
                raise RuntimeError("Repository worktree metadata is not a safe directory")
            state["worktreeMetadata"] = sorted(
                ".git/worktrees/" + entry.name[:400] for entry in os.scandir(worktrees_dir)
            )
            if state["worktreeMetadata"]:
                raise RuntimeError("Repository is a shared Git primary with linked worktree metadata and is retained in this release")
        filters_output, filters_error = run_git(root, ["config", "--local", "--get-regexp", r"^filter\."])
        if filters_error is None and filters_output.strip():
            raise RuntimeError("Repository-defined Git filters are retained because cleanup inspection never executes them")
        alternates = os.path.join(root, ".git", "objects", "info", "alternates")
        if os.path.lexists(alternates):
            raise RuntimeError("Repositories with alternate object stores are retained in this release")
        state["localScripts"] = local_git_scripts(root)
        top = git_lines(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
        if len(top) != 1 or os.path.realpath(top[0]) != os.path.realpath(root):
            raise RuntimeError("Git top-level does not match the candidate path")
        state["headSha"] = resolve_commit(root, "HEAD")
        branch_output, branch_error = run_git(root, ["symbolic-ref", "-q", "--short", "HEAD"])
        state["detached"] = branch_error is not None or not branch_output.strip()
        state["currentBranch"] = None if state["detached"] else branch_output.decode("utf-8", "replace").strip()[:400]
        # Every ref, not only branches and tags: commits held only by remote-tracking,
        # notes, original, bisect or custom refs must be proven or retain the checkout.
        ref_lines = sorted(git_lines(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)"]))
        state["refsDigest"] = digest_lines(ref_lines)
        others = []
        for line in ref_lines:
            parts = line.split("\0")
            if len(parts) != 3 or not SHA.fullmatch(parts[1]):
                raise RuntimeError("Git reported a malformed ref")
            name, object_id, object_type = parts
            if name.startswith("refs/heads/") or name.startswith("refs/tags/"):
                commit = resolve_commit(root, name)
                item = {"name": name.split("/", 2)[-1][:400], "commitSha": commit}
                state["localBranches" if name.startswith("refs/heads/") else "localTags"].append(item)
            elif name == "refs/stash":
                # A missing or expired stash reflog still leaves this tip reachable, so fsck will not report it.
                try:
                    commit = object_id if object_type == "commit" else resolve_commit(root, name)
                except RuntimeError:
                    state["unsupportedRefs"].append(name[:400])
                else:
                    state["stashCommits"].append(commit)
            elif name.startswith("refs/replace/") or object_type not in ("commit", "tag"):
                state["unsupportedRefs"].append(name[:400])
            else:
                others.append((name, object_id, object_type))
        reachable_history = set(git_lines(root, ["rev-list", "--branches", "--tags"]))
        for name, object_id, object_type in others:
            try:
                commit = object_id if object_type == "commit" else resolve_commit(root, name)
            except RuntimeError:
                state["unsupportedRefs"].append(name[:400])
                continue
            if commit not in reachable_history:
                state["extraRefs"].append({"name": name[:400], "commitSha": commit})
        stash_output, stash_error = run_git(root, ["reflog", "show", "refs/stash", "--format=%H"])
        stash_refs = [] if stash_error else stash_output.decode("utf-8", "replace").splitlines()
        state["stashCommits"] = sorted(set(state["stashCommits"]) | set(value for value in stash_refs if SHA.fullmatch(value)))
        reflog = git_lines(root, ["reflog", "--all", "--format=%H"])
        state["reflogCommits"] = sorted(set(value for value in reflog if SHA.fullmatch(value)))
        state["reflogOnlyCommits"] = sorted(set(state["reflogCommits"]) - reachable_history - set(state["stashCommits"]))
        fsck = git_lines(root, ["fsck", "--unreachable", "--no-progress"])
        state["unreachableObjects"] = sorted(set(line[:500] for line in fsck
            if re.match(r"^(unreachable|dangling) (blob|tree|commit|tag) [0-9a-f]{40,64}$", line)))
        state["dirtyEntries"] = sorted(entry[:500] for entry in git_entries(root,
            ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--ignore-submodules=none"]))
        state["ignoredEntries"] = sorted(entry[:500] for entry in git_entries(root,
            ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]))
        remotes_output, remotes_error = run_git(root, ["config", "--local", "--get-regexp", r"^remote\..*\.url$"])
        remote_lines = [] if remotes_error else remotes_output.decode("utf-8", "replace").splitlines()
        state["remoteUrls"] = sorted(set(line.strip() for line in remote_lines
            for line in [line.split(None, 1)[1] if len(line.split(None, 1)) == 2 else ""] if line.strip()))
        for line in git_lines(root, ["ls-files", "--stage"]):
            parts = line.split(None, 3)
            if parts and parts[0] == "160000" and len(parts) == 4:
                state["submodules"].append(parts[3].split("\t", 1)[-1][:500])
    except Exception as exc:
        state["error"] = str(exc)[:1000]
    # The fingerprint covers the complete lists; only bounded samples leave the guest.
    material = json.dumps({key: state[key] for key in state if key != "error"}, sort_keys=True, separators=(",", ":"))
    state["fingerprint"] = hashlib.sha256(material.encode()).hexdigest()
    state["counts"] = {key: len(state[key]) for key in LIST_KEYS}
    for key in LIST_KEYS:
        if key in PROOF_KEYS and len(state[key]) > MAX_PROOF_COMMITS and not state.get("error"):
            # Proof inputs are never truncated silently; an oversized proof fails closed.
            state["error"] = "Repository has too many refs or unpublished commits for a bounded remote proof"
        state[key] = state[key][:MAX_PROOF_COMMITS if key in PROOF_KEYS else SAMPLE]
    return state

def retains(repository):
    return bool(repository.get("error")) or any(repository["counts"].get(key) for key in BLOCKING_KEYS)

def measure_allocated(root, deadline):
    # Allocation is measured independently of the content-verification budget.
    try:
        root_info = os.lstat(root)
    except Exception as exc:
        return None, None, 0, [], "Could not measure .: " + str(exc)
    allocated = recoverable = entries = last_ns = 0
    linked = {}
    cross_device = []
    stack = [(root, "", root_info)]
    while stack:
        current, relative, info = stack.pop()
        entries += 1
        if entries > MAX_MEASURE_ENTRIES or (entries % 4096 == 0 and time.monotonic() > deadline):
            return None, None, last_ns, cross_device, "Workspace allocation measurement exceeded its time or entry budget"
        last_ns = max(last_ns, info.st_mtime_ns)
        blocks = getattr(info, "st_blocks", 0) * 512
        if stat.S_ISDIR(info.st_mode) or info.st_nlink <= 1:
            allocated += blocks
            recoverable += blocks
        else:
            key = (info.st_dev, info.st_ino)
            seen = linked.get(key)
            if seen is None:
                linked[key] = [blocks, info.st_nlink, 1]
                allocated += blocks
            else:
                seen[2] += 1
        if not stat.S_ISDIR(info.st_mode):
            continue
        try:
            children = list(os.scandir(current))
        except Exception as exc:
            return None, None, last_ns, cross_device, "Could not measure " + (relative or ".") + ": " + str(exc)
        for entry in children:
            rel = os.path.join(relative, entry.name) if relative else entry.name
            try:
                child = entry.stat(follow_symlinks=False)
            except Exception as exc:
                return None, None, last_ns, cross_device, "Could not measure " + rel + ": " + str(exc)
            if child.st_dev != root_info.st_dev:
                cross_device.append(rel[:500])
                continue
            stack.append((entry.path, rel, child))
    for blocks, nlink, seen in linked.values():
        if seen >= nlink:
            recoverable += blocks
    return allocated, recoverable, last_ns, cross_device, None

def mounts_beneath(path):
    found = []
    try:
        with open("/proc/self/mountinfo", encoding="utf-8", errors="replace") as source:
            lines = source.read().splitlines()
    except OSError:
        return found
    for line in lines:
        fields = line.split(" ")
        if len(fields) < 5:
            continue
        point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
        if bounded(point, path):
            found.append(os.path.relpath(point, path)[:500])
    return found

def scan_content(root, root_dev):
    digest = hashlib.sha256()
    hashed = 0
    file_count = 0
    unsafe = []
    special = []
    error = None
    stack = [(root, "")]
    while stack:
        current, relative = stack.pop()
        try:
            entries = sorted(os.scandir(current), key=lambda item: item.name)
        except Exception as exc:
            error = "Could not read " + (relative or ".") + ": " + str(exc)
            break
        for entry in entries:
            rel = os.path.join(relative, entry.name) if relative else entry.name
            try:
                info = entry.stat(follow_symlinks=False)
            except Exception as exc:
                error = "Could not inspect " + rel + ": " + str(exc)
                break
            file_count += 1
            if file_count > MAX_SCAN_FILES:
                error = "Workspace content exceeded the 100,000-entry verification budget"
                break
            digest.update((rel + "\0" + str(info.st_mode) + "\0" + str(info.st_size) + "\0" + str(info.st_mtime_ns) + "\0" + str(info.st_ino) + "\0").encode())
            if info.st_dev != root_dev:
                special.append(rel[:500])
                continue
            if stat.S_ISLNK(info.st_mode):
                unsafe.append(rel[:500])
                continue
            if stat.S_ISDIR(info.st_mode):
                if entry.name == ".git":
                    continue
                stack.append((entry.path, rel))
                continue
            if not stat.S_ISREG(info.st_mode):
                special.append(rel[:500])
                continue
            if hashed + info.st_size > MAX_HASH_BYTES:
                error = "Workspace content exceeded the 256 MiB verification budget"
                break
            try:
                with open(entry.path, "rb", buffering=0) as source:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        hashed += len(chunk)
                        digest.update(chunk)
            except Exception as exc:
                error = "Could not hash " + rel + ": " + str(exc)
                break
        if error:
            break
    return digest.hexdigest(), unsafe, special, error

def discover_repositories(root):
    found = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(os.scandir(current), key=lambda item: item.name)
        except Exception:
            continue
        names = {entry.name: entry for entry in entries}
        if names.get(".git") is not None:
            found.append(current)
        for entry in entries:
            if entry.name in SKIP_NAMES or entry.is_symlink():
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
            except OSError:
                continue
    return sorted(set(found))

def nested_repositories(root):
    return [os.path.relpath(candidate, root) for candidate in discover_repositories(root)
        if os.path.normpath(candidate) != os.path.normpath(root)]

def validated(request, ctx):
    path = os.path.normpath(str(request.get("path", "")))
    workspace = os.path.normpath(str(request.get("workspaceRoot", "")))
    source = request.get("source")
    stable = None
    if path != request.get("path") or workspace != request.get("workspaceRoot"):
        ok = False
    elif source == "agent":
        ok = bounded(path, ctx["agents"]) and path != ctx["agents"] and workspace == path
    elif source == "conversation-child":
        parts = os.path.relpath(workspace, ctx["conversations"]).split(os.sep)
        ok = (bounded(workspace, ctx["conversations"]) and len(parts) == 2 and re.fullmatch(r"[0-9a-f]{32}", parts[0]) is not None
            and parts[1] == "workspace" and bounded(path, workspace) and path != workspace)
        stable = parts[0] if ok else None
    else:
        ok = False
    return path, workspace, source, stable, ok

def capped(values):
    return sorted(set(values))[:SAMPLE]

def inspect_candidate(path, workspace, source, stable):
    info = os.lstat(path)
    real = os.path.realpath(path)
    allocated, recoverable, last_ns, cross_device, measurement_error = measure_allocated(path, time.monotonic() + MEASURE_SECONDS)
    repository = repository_state(path, nested_repositories(path))
    unsafe = ["."] if stat.S_ISLNK(info.st_mode) or real != path else []
    mounts = sorted(set(cross_device + mounts_beneath(path)))
    special = []
    content = ""
    scan_error = None
    verified = False
    # Content is verified only for checkouts that could still qualify; retained ones need no hash.
    if not retains(repository) and not unsafe and not mounts:
        content, unsafe_entries, special, scan_error = scan_content(path, info.st_dev)
        unsafe += unsafe_entries
        verified = scan_error is None
    result = {
        "path": path, "workspaceRoot": workspace, "persistenceKeyHash": stable, "source": source,
        "allocatedBytes": allocated if measurement_error is None else None,
        "recoverableBytes": recoverable if measurement_error is None else None,
        "lastActivityAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_ns / 1000000000)) if last_ns else None,
        "identity": {"realPath": real, "device": info.st_dev, "inode": info.st_ino, "mode": info.st_mode,
            "size": info.st_size, "modifiedNanoseconds": str(info.st_mtime_ns), "contentFingerprint": content},
        "contentVerified": verified, "repository": repository,
        "unsafeSymlinks": capped(unsafe), "specialFiles": capped(special), "mountPoints": capped(mounts),
    }
    errors = [value for value in (measurement_error, scan_error) if value]
    if errors:
        result["scanError"] = "; ".join(errors)[:1000]
    if stable is None:
        result.pop("persistenceKeyHash")
    return result

def list_candidates(ctx):
    candidates = []
    errors = []
    agents = ctx["agents"]
    conversations = ctx["conversations"]
    try:
        agent_repositories = discover_repositories(agents) if os.path.isdir(agents) else []
        for candidate in agent_repositories:
            if candidate == agents or any(other != candidate and bounded(candidate, other) for other in agent_repositories):
                continue
            candidates.append({"path": candidate, "workspaceRoot": candidate, "source": "agent"})
    except Exception as exc:
        errors.append("Agent workspace inventory failed: " + str(exc))
    try:
        if os.path.isdir(conversations):
            for stable in sorted(os.scandir(conversations), key=lambda item: item.name):
                if not re.fullmatch(r"[0-9a-f]{32}", stable.name) or stable.is_symlink() or not stable.is_dir(follow_symlinks=False):
                    continue
                workspace = os.path.join(stable.path, "workspace")
                if not os.path.isdir(workspace) or os.path.islink(workspace):
                    continue
                repositories = discover_repositories(workspace)
                for candidate in repositories:
                    if candidate == workspace:
                        continue
                    if any(other not in {candidate, workspace} and bounded(candidate, other) for other in repositories):
                        continue
                    candidates.append({"path": candidate, "workspaceRoot": workspace, "source": "conversation-child",
                        "persistenceKeyHash": stable.name})
    except Exception as exc:
        errors.append("Conversation workspace inventory failed: " + str(exc))
    return {"candidates": candidates, "errors": errors}

def inspect(request, ctx):
    path, workspace, source, stable, ok = validated(request, ctx)
    if not ok:
        raise SystemExit(73)
    return inspect_candidate(path, workspace, source, stable)

def container_inventory(docker):
    # Names and mount sources of every guest container; None when unknown (fail closed).
    try:
        listed = subprocess.run([docker, "ps", "-aq", "--no-trunc"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)
        if listed.returncode != 0:
            return None
        ids = [value for value in listed.stdout.decode("utf-8", "replace").split() if re.fullmatch(r"[0-9a-f]{12,64}", value)]
        if not ids:
            return set(), []
        inspected = subprocess.run([docker, "inspect", "--format", "{{.Name}}{{range .Mounts}}\t{{.Source}}{{end}}"] + ids,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)
        if inspected.returncode != 0:
            return None
        names = set()
        mounts = []
        for line in inspected.stdout.decode("utf-8", "replace").splitlines():
            parts = line.split("\t")
            if parts[0].strip():
                names.add(parts[0].strip().lstrip("/"))
            mounts.extend(os.path.normpath(value) for value in parts[1:] if value.startswith("/"))
        return names, mounts
    except Exception:
        return None

def entry_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def snapshot_tree(directory_fd, root_dev):
    # Descriptor-pinned, no-follow image of every entry, including .git internals.
    snapshot = {}
    for name in sorted(os.listdir(directory_fd)):
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if info.st_dev != root_dev:
            raise RuntimeError("Workspace contains a mounted or cross-device entry")
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise RuntimeError("Workspace contains an unsafe entry")
        children = None
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise RuntimeError("Workspace entry was replaced while it was read")
                children = snapshot_tree(child, root_dev)
            finally:
                os.close(child)
        snapshot[name] = {"key": entry_key(info), "nlink": info.st_nlink,
            "bytes": getattr(info, "st_blocks", 0) * 512, "children": children}
    return snapshot

def unchanged(info, expected, progress):
    if (info.st_dev, info.st_ino) in progress["touched"]:
        # Unlinking a sibling hard link moves only this inode's ctime.
        return entry_key(info)[:5] == expected["key"][:5]
    return entry_key(info) == expected["key"]

def remove_tree(directory_fd, snapshot, progress, metadata_last=False):
    if sorted(os.listdir(directory_fd)) != sorted(snapshot):
        raise RuntimeError("Workspace entries changed after verification")
    # Working files go first and .git last, so an interrupted removal keeps the repository metadata.
    for name in sorted(snapshot, key=lambda item: (metadata_last and item == ".git", item)):
        expected = snapshot[name]
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not unchanged(info, expected, progress):
            raise RuntimeError("Workspace entry changed after verification")
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise RuntimeError("Workspace entry was replaced during removal")
                remove_tree(child, expected["children"], progress)
            finally:
                os.close(child)
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_mode) != expected["key"][:3]:
                raise RuntimeError("Workspace entry was replaced during removal")
            os.rmdir(name, dir_fd=directory_fd)
            progress["bytes"] += expected["bytes"]
        else:
            os.unlink(name, dir_fd=directory_fd)
            identity = (info.st_dev, info.st_ino)
            seen = progress["links"].get(identity, 0) + 1
            progress["links"][identity] = seen
            progress["touched"].add(identity)
            # Data is freed only when its last link inside the reviewed tree is gone.
            if seen >= expected["nlink"]:
                progress["bytes"] += expected["bytes"]
        progress["entries"] += 1

def open_beneath(root_fd, relative):
    current = os.dup(root_fd)
    try:
        for component in [item for item in relative.split(os.sep) if item and item != "."]:
            if component == "..":
                raise RuntimeError("Workspace path escaped its approved root")
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise

def blocked(reason):
    return {"status": "blocked", "reason": reason, "removedBytes": 0, "guestFreeSpaceDeltaBytes": None}

def free_space_delta(measurement_fd, before):
    if measurement_fd is None or before is None:
        return None
    try:
        after = os.fstatvfs(measurement_fd)
        return max(0, (after.f_bavail - before.f_bavail) * after.f_frsize)
    except OSError:
        return None

def delete(request, ctx):
    started = time.monotonic()
    path, workspace, source, stable, ok = validated(request, ctx)
    if not ok:
        return blocked("Target is outside its approved guest code-workspace boundary")
    containers = container_inventory(ctx["docker"])
    if containers is None:
        return blocked("Container inventory is unavailable; cleanup retained the workspace")
    names, mount_sources = containers
    for mounted in mount_sources:
        in_runtime = any(bounded(mounted, root) and mounted != root for root in (ctx["agents"], ctx["conversations"]))
        if in_runtime and (bounded(mounted, path) or bounded(path, mounted)):
            return blocked("An agent container still mounts this workspace")
    snapshot = request.get("claims") or {}
    lock_fd, reason = acquire_cleanup(ctx["claims"], workspace, str(snapshot.get("instance", "")),
        set(snapshot.get("liveTokens", [])), int(snapshot.get("sequence", 0)), names)
    if lock_fd is None:
        return blocked(reason)
    removal_started = False
    progress = {"bytes": 0, "entries": 0, "links": {}, "touched": set()}
    boundary_fd = parent_fd = measurement_fd = before = None
    try:
        boundary = ctx["agents"] if source == "agent" else ctx["conversations"]
        boundary_fd = os.open(boundary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        name = os.path.basename(path)
        parent_fd = open_beneath(boundary_fd, os.path.relpath(os.path.dirname(path), boundary))
        measurement_fd = os.dup(boundary_fd) if source == "agent" else open_beneath(boundary_fd, os.path.relpath(workspace, boundary))
        root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            info = os.fstat(root_fd)
            expected = request["identity"]
            if info.st_dev != expected["device"] or info.st_ino != expected["inode"]:
                raise RuntimeError("Workspace identity changed after review")
            # Pin the exact removal set before any proof: verification can only bless this image.
            pinned = snapshot_tree(root_fd, info.st_dev)
            # Verify through the pinned directory itself, never by re-resolving the path.
            os.fchdir(root_fd)
            if os.getcwd() != path:
                raise RuntimeError("Workspace path no longer resolves to the reviewed directory")
            _, _, _, cross_device, measurement_error = measure_allocated(".", time.monotonic() + MEASURE_SECONDS)
            content, unsafe, special, scan_error = scan_content(".", info.st_dev)
            repository = repository_state(".", nested_repositories("."))
            if cross_device or mounts_beneath(path):
                raise RuntimeError("Workspace contains a mounted or cross-device entry")
            if measurement_error or scan_error or unsafe or special or repository.get("error"):
                raise RuntimeError(measurement_error or scan_error or repository.get("error") or "Workspace became unsafe after review")
            if content != expected["contentFingerprint"] or repository["fingerprint"] != request["gitFingerprint"]:
                raise RuntimeError("Workspace content or Git history changed after review")
            if retains(repository):
                raise RuntimeError("Workspace acquired local-only content after review")
            # Anything written while verification ran is unproven: abort before the first unlink.
            current = os.stat(path, follow_symlinks=False)
            if snapshot_tree(root_fd, info.st_dev) != pinned or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise RuntimeError("Workspace changed during verification")
            if time.monotonic() - started > VERIFY_SECONDS:
                raise RuntimeError("Verification exceeded its time budget")
            before = os.fstatvfs(measurement_fd)
            removal_started = True
            remove_tree(root_fd, pinned, progress, True)
        finally:
            os.chdir("/")
            os.close(root_fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if current.st_dev != info.st_dev or current.st_ino != info.st_ino:
            raise RuntimeError("Workspace root was replaced during removal")
        os.rmdir(name, dir_fd=parent_fd)
        progress["bytes"] += getattr(info, "st_blocks", 0) * 512
        progress["entries"] += 1
        return {"status": "removed", "removedBytes": progress["bytes"], "removedEntries": progress["entries"],
            "guestFreeSpaceDeltaBytes": free_space_delta(measurement_fd, before)}
    except Exception as exc:
        if not removal_started:
            return {"status": "failed", "reason": ("Nothing was removed: " + str(exc))[:1000], "removedBytes": 0,
                "removedEntries": 0, "guestFreeSpaceDeltaBytes": None}
        partial = progress["entries"] > 0
        prefix = ("Removal stopped after " + str(progress["entries"]) + " entries were removed; the remaining files and "
            "repository metadata were retained at " + path + ": ") if partial else "Removal stopped before any entry was removed: "
        return {"status": "partial" if partial else "failed", "reason": (prefix + str(exc))[:1000],
            "removedBytes": progress["bytes"], "removedEntries": progress["entries"],
            "guestFreeSpaceDeltaBytes": free_space_delta(measurement_fd, before)}
    finally:
        for fd in (measurement_fd, parent_fd, boundary_fd):
            if fd is not None:
                os.close(fd)
        release_cleanup(ctx["claims"], workspace, lock_fd)

def context(fixture):
    if fixture is None:
        return {"agents": AGENTS, "conversations": CONVERSATIONS, "claims": CLAIMS, "docker": "docker"}
    fixture = os.path.realpath(fixture)
    if not fixture.startswith(("/tmp/sulla-storage-cleanup-tests/", "/private/tmp/sulla-storage-cleanup-tests/")):
        raise SystemExit(73)
    return {"agents": os.path.join(fixture, "agents"), "conversations": os.path.join(fixture, "conversations"),
        "claims": os.path.join(fixture, "claims"), "docker": os.path.join(fixture, "bin", "docker")}

mode = sys.argv[1]
request = json.loads(sys.argv[2])
ctx = context(sys.argv[3] if len(sys.argv) > 3 else None)
if mode == "list":
    print(json.dumps(list_candidates(ctx), separators=(",", ":")))
elif mode == "inspect":
    print(json.dumps(inspect(request, ctx), separators=(",", ":")))
elif mode == "delete":
    print(json.dumps(delete(request, ctx), separators=(",", ":")))
else:
    raise SystemExit(64)
` }`;

function parseJson<T>(value:string, label:string):T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${ label } returned invalid JSON`);
  }
}

function fixtureArgs(fixtureRoot?:string):string[] {
  if (fixtureRoot === undefined) return [];
  const normalized = fixtureRoot.replace(/\/+$/, '');
  if (!FIXTURE_ROOTS.some(root => normalized.startsWith(root))) {
    throw new Error('Storage cleanup fixture escaped its disposable test root');
  }
  return [normalized];
}

function helper(mode:'list' | 'inspect' | 'delete', request:unknown, fixtureRoot?:string):string[] {
  return ['python3', '-c', GUEST_STORAGE_HELPER, mode, JSON.stringify(request), ...fixtureArgs(fixtureRoot)];
}

function sanitizeReason(value:unknown):string {
  return String((value as Error)?.message ?? value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .slice(0, 500);
}

function failedCandidate(ref:GuestCandidateRef, reason:string):GuestStorageCandidate {
  return {
    ...ref,
    allocatedBytes:   null,
    recoverableBytes: null,
    lastActivityAt:   null,
    identity:         { realPath: ref.path, device: 0, inode: 0, mode: 0, size: 0, modifiedNanoseconds: '0', contentFingerprint: '' },
    contentVerified:  false,
    repository:       {
      headSha:            null,
      detached:           false,
      currentBranch:      null,
      localBranches:      [],
      localTags:          [],
      extraRefs:          [],
      unsupportedRefs:    [],
      localScripts:       [],
      refsDigest:         '',
      reflogCommits:      [],
      reflogOnlyCommits:  [],
      unreachableObjects: [],
      stashCommits:       [],
      dirtyEntries:       [],
      ignoredEntries:     [],
      remoteUrls:         [],
      worktreeMetadata:   [],
      submodules:         [],
      nestedRepositories: [],
      counts:             {},
      fingerprint:        '',
      error:              reason,
    },
    unsafeSymlinks: [],
    specialFiles:   [],
    mountPoints:    [],
    scanError:      reason,
  };
}

async function inspectWith(ref:GuestCandidateRef, runner:GuestRunner, fixtureRoot?:string):Promise<GuestStorageCandidate> {
  try {
    const output = await runner(helper('inspect', ref, fixtureRoot), undefined, INSPECT_TIMEOUT_MS);
    return parseJson<GuestStorageCandidate>(output, 'Guest workspace inspection');
  } catch (error) {
    return failedCandidate(ref, `Workspace inspection did not complete: ${ sanitizeReason(error) }`);
  }
}

/** Lists candidates once, then inspects each in its own bounded guest call. */
async function scanWith(runner:GuestRunner, fixtureRoot?:string):Promise<GuestStorageScan> {
  const listed = parseJson<{ candidates: GuestCandidateRef[]; errors: string[] }>(
    await runner(helper('list', {}, fixtureRoot), undefined, LIST_TIMEOUT_MS), 'Guest storage inventory');
  const deadline = Date.now() + INVENTORY_BUDGET_MS;
  const candidates:GuestStorageCandidate[] = new Array(listed.candidates.length);
  let next = 0;
  const worker = async() => {
    while (next < listed.candidates.length) {
      const index = next++;
      const ref = listed.candidates[index];
      candidates[index] = Date.now() > deadline
        ? failedCandidate(ref, 'Workspace was not inspected within the inventory time budget')
        : await inspectWith(ref, runner, fixtureRoot);
    }
  };
  await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, listed.candidates.length) }, worker));
  return { candidates, errors: listed.errors };
}

export function scanGuestStorage(runner:GuestRunner = runGuest):Promise<GuestStorageScan> {
  return scanWith(runner);
}

export function inspectGuestStorageCandidate(ref:GuestCandidateRef, runner:GuestRunner = runGuest):Promise<GuestStorageCandidate> {
  return inspectWith(ref, runner);
}

/** Read-only real-Git seam restricted to task-owned disposable fixtures. */
export function scanStorageCleanupFixture(fixtureRoot:string, runner:GuestRunner):Promise<GuestStorageScan> {
  fixtureArgs(fixtureRoot);
  return scanWith(runner, fixtureRoot);
}

export function inspectStorageCleanupFixture(ref:GuestCandidateRef, fixtureRoot:string, runner:GuestRunner):Promise<GuestStorageCandidate> {
  fixtureArgs(fixtureRoot);
  return inspectWith(ref, runner, fixtureRoot);
}

export async function removeGuestStorageCandidate(request:GuestDeleteRequest, runner:GuestRunner = runGuest):Promise<GuestDeleteResult> {
  const claims = liveWorkspaceClaimSnapshot(request.workspaceRoot);
  const output = await runner(helper('delete', { ...request, claims }), undefined, DELETE_TIMEOUT_MS);
  return parseJson<GuestDeleteResult>(output, 'Guest storage removal');
}

/** Destructive only inside one validated task-owned fixture root. */
export async function removeStorageCleanupFixture(
  request:GuestDeleteRequest,
  fixtureRoot:string,
  runner:GuestRunner,
  claims:WorkspaceClaimSnapshot = liveWorkspaceClaimSnapshot(request.workspaceRoot),
):Promise<GuestDeleteResult> {
  const [normalized] = fixtureArgs(fixtureRoot);
  if (!(request.path === normalized || request.path.startsWith(`${ normalized }/`))) {
    throw new Error('Storage cleanup target escaped its disposable fixture');
  }
  const output = await runner(helper('delete', { ...request, claims }, fixtureRoot), undefined, DELETE_TIMEOUT_MS);
  return parseJson<GuestDeleteResult>(output, 'Storage cleanup fixture removal');
}

export const STORAGE_GUEST_ROOTS = {
  agents:        GUEST_AGENT_WORKSPACES_ROOT,
  conversations: GUEST_CONVERSATIONS_ROOT,
  claims:        GUEST_WORKSPACE_CLAIM_ROOT,
} as const;
