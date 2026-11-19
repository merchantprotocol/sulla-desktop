// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const qaRuntimeRoot = '/private/tmp/sulla-storage-qa-20261117/';
const sourceTests = [
  'pkg/sulla-desktop/agent/tests/Unit/Services/StorageCleanupGuestFixture.spec.ts',
  'pkg/sulla-desktop/agent/tests/Unit/Services/StorageCleanupService.spec.ts',
  'pkg/sulla-desktop/agent/tests/Unit/Settings/FilesSectionStorageCleanup.spec.ts',
  'pkg/sulla-desktop/main/SullaFilesIpcHandlers.spec.ts',
  'pkg/sulla-desktop/main/SullaFilesIpcProvider.spec.ts',
];

function fail(message) {
  process.stderr.write(`${ message }\n`);
  process.exitCode = 64;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(executable, args) {
  const result = childProcess.spawnSync(executable, args, { cwd: repositoryRoot, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const fixtureProgram = String.raw`
import json, os, re, subprocess, sys

token, remote, ref, persistence_key = sys.argv[1:]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,30}", token):
    raise SystemExit("invalid fixture token")
if not re.fullmatch(r"https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:[.]git)?", remote):
    raise SystemExit("fixture remote must be a canonical GitHub HTTPS URL")
if not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", ref) or ".." in ref:
    raise SystemExit("invalid fixture ref")

root = "/mnt/data/sulla/runtime/agents/storage-cleanup-qa-" + token
if os.path.lexists(root):
    raise SystemExit("fixture root already exists; use a fresh token or replace the disposable QA VM")
os.makedirs(root, mode=0o700)

env = dict(os.environ)
env.update({"HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"})
def git(*args, cwd=None):
    command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=never"] + list(args)
    subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, check=True, timeout=120)

clean = os.path.join(root, "pushed-current-ref")
git("clone", "--branch", ref, "--single-branch", "--", remote, clean)

def copy(name):
    target = os.path.join(root, name)
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
        "-c", "protocol.file.allow=always", "clone", "--no-hardlinks", "--", clean, target],
        env=env, stdin=subprocess.DEVNULL, check=True, timeout=120)
    git("remote", "set-url", "origin", remote, cwd=target)
    return target

unpushed = copy("committed-unpushed")
with open(os.path.join(unpushed, "storage-cleanup-unpushed.txt"), "w", encoding="utf-8") as output:
    output.write("local-only commit\n")
git("add", "storage-cleanup-unpushed.txt", cwd=unpushed)
git("-c", "user.name=Storage Cleanup QA", "-c", "user.email=qa@example.invalid", "commit", "-m", "local-only fixture", cwd=unpushed)

ignored = copy("ignored-content")
os.makedirs(os.path.join(ignored, "node_modules", "fixture"))
with open(os.path.join(ignored, ".git", "info", "exclude"), "a", encoding="utf-8") as output:
    output.write("node_modules/\n")
with open(os.path.join(ignored, "node_modules", "fixture", "index.js"), "w", encoding="utf-8") as output:
    output.write("retained dependency\n")

stashed = copy("local-stash")
tracked = subprocess.check_output(["git", "-C", stashed, "ls-files"], env=env, text=True).splitlines()[0]
with open(os.path.join(stashed, tracked), "a", encoding="utf-8") as output:
    output.write("\nstashed fixture\n")
git("stash", "push", "-m", "storage cleanup fixture", cwd=stashed)

nested = copy("nested-repository")
git("init", os.path.join(nested, "nested-local"))

unsafe = copy("symlink-escape")
os.symlink("/tmp", os.path.join(unsafe, "unsafe-link"))

conversation = None
if persistence_key:
    import hashlib
    stable = hashlib.sha256(persistence_key.encode()).hexdigest()[:32]
    conversation = "/mnt/data/sulla/runtime/conversations/" + stable + "/workspace/repo"
    os.makedirs(os.path.dirname(conversation), mode=0o700, exist_ok=True)
    git("clone", "--branch", ref, "--single-branch", "--", remote, conversation)

print(json.dumps({"fixtureRoot": root, "eligibleAgentClone": clean, "conversationChild": conversation,
  "expectedBlocked": [unpushed, ignored, stashed, nested, unsafe]}, indent=2))
`;

function printNativeSteps() {
  process.stdout.write(`${ JSON.stringify({
    status: 'coordinator-owned and unperformed by builder',
    steps: [
      'Start only the disposable QA runtime and rebuilt candidate using the coordinator runbook.',
      'Open Preferences > Files & backups > Storage & cleanup in the owned browser-harness profile.',
      'Verify the Files-backed project count/names, checkout repository and branch identities, associated chat context, measured bytes, reasons, and exact Details paths.',
      'Select only an eligible disposable fixture, click Review, and verify every exact identity/path plus every retained reason before continuing.',
      'Cancel the native dialog and read back that every fixture still exists and the receipt reports no removal.',
      'Create a fresh plan, confirm the native dialog, and verify only the selected child repository is absent while its conversation root, workspace container, provider homes, checkpoints, chats, and unrelated fixtures remain.',
      'Replay the same confirmation request and verify no second removal; let a plan expire and verify it blocks.',
      'Start a disposable agent against the target between preview and confirmation and verify the launch/use claim blocks removal.',
      'Record VM free-space delta separately; do not claim immediate host APFS recovery or run trim/compaction as part of this acceptance.',
      'At desktop and 390x844 viewports, capture screenshots and drain console/network events. Record native/app build lineage separately.',
    ],
  }, null, 2) }\n`);
}

if (process.argv.includes('--source-tests')) {
  run(path.join(repositoryRoot, 'node_modules', '.bin', 'vitest'), ['run', '--config', 'vitest.agent.config.mts', ...sourceTests]);
} else if (process.argv.includes('--prepare-qa-fixture')) {
  const runtimeInput = argument('--runtime');
  const token = argument('--token');
  const remote = argument('--remote');
  const ref = argument('--ref');
  const persistenceKey = argument('--persistence-key') ?? '';
  if (!process.argv.includes('--confirm-disposable-fixture')) fail('Pass --confirm-disposable-fixture to acknowledge mutation of the coordinator-owned QA VM.');
  else if (!runtimeInput || !token || !remote || !ref) fail('Fixture preparation requires --runtime, --token, --remote and --ref.');
  else {
    const runtime = fs.realpathSync(runtimeInput);
    if (!runtime.startsWith(qaRuntimeRoot) || !fs.statSync(runtime).isFile()) fail(`Runtime must be a file under ${ qaRuntimeRoot }`);
    else run(runtime, ['exec', '--', 'python3', '-c', fixtureProgram, token, remote, ref, persistenceKey]);
  }
} else if (process.argv.includes('--native-steps')) {
  printNativeSteps();
} else {
  process.stdout.write(`Usage:\n  node scripts/storage-cleanup-acceptance.mjs --source-tests\n  node scripts/storage-cleanup-acceptance.mjs --native-steps\n  node scripts/storage-cleanup-acceptance.mjs --prepare-qa-fixture --confirm-disposable-fixture --runtime ${ qaRuntimeRoot }yourRUNTIMEhere --token yourTOKENhere --remote https://github.com/yourOWNERhere/yourREPOhere.git --ref yourBRANCHhere [--persistence-key yourKEYhere]\n`);
}
