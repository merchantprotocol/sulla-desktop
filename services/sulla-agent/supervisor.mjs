import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const provider = process.env.SULLA_AGENT_PROVIDER || '';
const model = process.env.SULLA_AGENT_MODEL || '';
const instructions = '/tmp/sulla-agent-instructions.md';
let child = null;
let threadId = '';
let stopping = false;
let started = false;
let outputLineBuffer = '';
const queuedSteers = [];

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function shell(command, cwd, input, timeoutMs = 120_000) {
  return new Promise(resolve => {
    const proc = spawn('/bin/bash', ['-lc', command], { cwd: cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => proc.kill('SIGTERM'), Math.max(1, Number(timeoutMs) || 120_000));
    proc.stdout.on('data', chunk => stdout.push(chunk));
    proc.stderr.on('data', chunk => stderr.push(chunk));
    proc.once('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    if (input) proc.stdin.write(String(input));
    proc.stdin.end();
  });
}

function q(value) { return `'${ String(value).replaceAll("'", "'\\''") }'` }

async function localTool(tool, args) {
  if (tool === 'exec') {
    const result = await shell(String(args.command ?? args.cmd ?? ''), args.cwd, args.stdin, args.timeout);
    return { success: result.code === 0, result: result.code === 0 ? (result.stdout || '(no output)') : `Command failed with exit code ${ result.code }:\n${ result.stderr || result.stdout }` };
  }
  if (tool === 'read_file') return { success: true, result: await readFile(String(args.path ?? args.filePath), 'utf8') };
  if (tool === 'write_file') {
    const target = String(args.path ?? args.filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(args.content ?? ''), 'utf8');
    return { success: true, result: `Wrote ${ target }` };
  }
  if (tool === 'file_search') {
    const root = String(args.path ?? args.directory ?? process.cwd());
    const pattern = String(args.query ?? args.pattern ?? '');
    const result = await shell(`grep -RIl --exclude-dir=.git -- ${ q(pattern) } ${ q(root) } | head -200`);
    return { success: result.code === 0 || result.code === 1, result: result.stdout };
  }

  const repo = String(args.absolutePath ?? process.cwd());
  const files = Array.isArray(args.files) ? args.files : [];
  const diffRange = args.commitA && args.commitB ? `${ q(args.commitA) } ${ q(args.commitB) }` : args.commitA ? q(args.commitA) : '';
  const worktree = () => {
    switch (args.action) {
    case 'list': return `git -C ${ q(repo) } worktree list --porcelain`;
    case 'prune': return `git -C ${ q(repo) } worktree prune -v`;
    case 'remove': return `git -C ${ q(repo) } worktree remove ${ args.force ? '--force' : '' } ${ q(args.worktreePath) }`;
    case 'add': return `git -C ${ q(repo) } worktree add ${ args.createBranch ? `-b ${ q(args.branch) }` : '' } ${ q(args.worktreePath) } ${ q(args.commitish || args.branch || 'HEAD') }`;
    default: return '';
    }
  };
  const branch = () => {
    switch (args.action) {
    case 'list': return `git -C ${ q(repo) } branch -a --no-color`;
    case 'create': return `git -C ${ q(repo) } checkout -b ${ q(args.branchName) }`;
    case 'switch': return `git -C ${ q(repo) } checkout ${ q(args.branchName) }`;
    case 'delete': return `git -C ${ q(repo) } branch -d ${ q(args.branchName) }`;
    default: return '';
    }
  };
  const stash = () => {
    const ref = args.stashRef || 'stash@{0}';
    if (args.action === 'save') return `git -C ${ q(repo) } stash push ${ args.message ? `-m ${ q(args.message) }` : '' }`;
    if (args.action === 'list') return `git -C ${ q(repo) } stash list`;
    return `git -C ${ q(repo) } stash ${ q(args.action) } ${ q(ref) }`;
  };
  const commands = {
    git_status: `git -C ${ q(repo) } status --short --branch`,
    git_log: `git -C ${ q(repo) } log ${ args.oneline === false ? '' : '--oneline' } -n ${ Number(args.limit ?? 20) }`,
    git_diff: `git -C ${ q(repo) } diff ${ args.staged ? '--cached' : '' } ${ diffRange } ${ args.filePath ? `-- ${ q(args.filePath) }` : '' }`,
    git_blame: `git blame ${ args.startLine ? `-L ${ Number(args.startLine) },${ Number(args.endLine ?? args.startLine) }` : '' } -- ${ q(repo) }`,
    git_conflicts: `git -C ${ q(repo) } diff --name-only --diff-filter=U`,
    git_add: `git -C ${ q(repo) } add -- ${ (files.length ? files : ['.']).map(q).join(' ') }`,
    git_commit: `git -C ${ q(repo) } add -- ${ (files.length ? files : ['.']).map(q).join(' ') } && git -C ${ q(repo) } -c user.name='Jonathon Byrdziak' -c user.email='205828+jonathonbyrdziak@users.noreply.github.com' commit -m ${ q(args.message) }`,
    git_fetch: `git -C ${ q(repo) } fetch ${ q(args.remote ?? 'origin') } ${ args.branch ? q(args.branch) : '' } ${ args.prune ? '--prune' : '' }`,
    git_pull: `git -C ${ q(repo) } pull ${ q(args.remote ?? 'origin') } ${ args.branch ? q(args.branch) : '' }`,
    git_push: `git -C ${ q(repo) } push ${ args.force ? '--force-with-lease' : '' } ${ args.tags ? '--tags' : '' } ${ q(args.remote ?? 'origin') } ${ args.branch ? q(args.branch) : '' }`,
    git_branch: branch(),
    git_checkout: `git -C ${ q(repo) } checkout ${ q(args.ref ?? 'HEAD') } -- ${ files.map(q).join(' ') }`,
    git_stash: stash(),
    git_worktree: worktree(),
    github_init: `git init ${ q(repo) }`,
    github_add_remote: `git -C ${ q(repo) } remote add ${ q(args.remoteName ?? 'origin') } ${ q(args.remoteUrl) }`,
  };
  const command = commands[tool];
  if (!command) return { success: false, error: { code: 'agent_local_unsupported', message: `${ tool } has no container-local implementation` } };
  const result = await shell(command, repo, undefined, 120_000);
  return { success: result.code === 0, result: result.code === 0 ? (result.stdout || result.stderr || 'ok') : (result.stderr || result.stdout) };
}

const localServer = http.createServer(async(request, response) => {
  try {
    const expected = (await readFile('/run/secrets/sulla-agent/SULLA_API_TOKEN', 'utf8')).trim();
    const actual = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!expected || actual !== expected) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: { code: 'forbidden', message: 'Invalid agent-local capability' } }));
      return;
    }
    const match = /^\/v1\/tools\/([^/]+)$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match) {
      response.writeHead(404).end();
      return;
    }
    const result = await localTool(decodeURIComponent(match[1]), await body(request));
    response.writeHead(result.success ? 200 : 500, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: false, error: { code: 'agent_local_failed', message: error instanceof Error ? error.message : String(error) } }));
  }
});
localServer.listen(8789, '0.0.0.0');

function emit(data) {
  process.stdout.write(data);
  const lines = `${ outputLineBuffer }${ String(data) }`.split('\n');
  outputLineBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
      if (provider === 'claude-code' && event.type === 'result' && queuedSteers.length === 0) child?.stdin.end();
    } catch { /* provider diagnostics may be plain text */ }
  }
}

function commonCodexArgs(resume = false) {
  const args = ['exec', '-c', 'shell_environment_policy.inherit=all'];
  if (resume) args.push('resume', threadId);
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
  args.push('-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false');
  args.push('-c', `model_instructions_file=${ JSON.stringify(instructions) }`);
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

function launchCodex(prompt, resume = false) {
  child = spawn('codex', commonCodexArgs(resume), { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', emit);
  child.stderr.on('data', data => process.stderr.write(data));
  child.stdin.end(prompt);
  child.once('close', code => {
    child = null;
    if (stopping) return process.exit(code || 130);
    if (queuedSteers.length > 0 && threadId) {
      const prompt = queuedSteers.splice(0).join('\n\n');
      launchCodex(prompt, true);
      return;
    }
    process.exit(code ?? 1);
  });
}

function launchClaude(prompt) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--dangerously-skip-permissions', '--input-format', 'stream-json', '--replay-user-messages',
    '--append-system-prompt-file', instructions];
  if (model) args.push('--model', model);
  child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', emit);
  child.stderr.on('data', data => process.stderr.write(data));
  child.once('close', code => process.exit(stopping ? (code || 130) : (code ?? 1)));
  child.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) }\n`);
}

function start(prompt) {
  if (started) return;
  started = true;
  if (provider === 'claude-code') launchClaude(prompt);
  else if (provider === 'codex') launchCodex(prompt);
  else throw new Error(`Unsupported SULLA_AGENT_PROVIDER=${ provider }`);
}

function steer(message) {
  if (!child || !message) return;
  if (provider === 'claude-code') {
    child.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] } }) }\n`);
    return;
  }
  queuedSteers.push(message);
  if (threadId) child.kill('SIGINT');
}

function cancel() {
  stopping = true;
  if (!child) process.exit(130);
  child.kill('SIGTERM');
  setTimeout(() => child?.kill('SIGKILL'), 5_000).unref();
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let command;
  try { command = JSON.parse(line) } catch { return }
  if (command.type === 'start') start(String(command.prompt ?? ''));
  else if (command.type === 'steer') steer(String(command.message ?? ''));
  else if (command.type === 'cancel') cancel();
});
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);
