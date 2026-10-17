import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const provider = process.env.SULLA_AGENT_PROVIDER || '';
const model = process.env.SULLA_AGENT_MODEL || '';
const instructions = '/tmp/sulla-agent-instructions.md';
let child = null;
let threadId = '';
let stopping = false;
let started = false;
let outputLineBuffer = '';
const queuedSteers = [];
const claudeSteersInFlight = [];
let codexSteersAwaitingActivity = [];
let claudeResultGrace = null;
const MAX_OUTPUT_BYTES = 200_000;

function appendBounded(chunks, chunk, state) {
  const value = Buffer.from(chunk);
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - state.bytes);
  if (remaining > 0) chunks.push(value.subarray(0, remaining));
  state.bytes += value.length;
  if (state.bytes > MAX_OUTPUT_BYTES) state.truncated = true;
}

function processIdentity(pid) {
  try {
    const fields = readFileSync(`/proc/${ pid }/stat`, 'utf8').split(' ');
    return { pgrp: Number(fields[4]), started: fields[21] };
  } catch { return null }
}

function groupMembers(pgrp) {
  try {
    return readdirSync('/proc').filter(value => /^\d+$/.test(value)).flatMap(value => {
      const pid = Number(value);
      const identity = processIdentity(pid);
      return identity?.pgrp === pgrp ? [{ pid, started: identity.started }] : [];
    });
  } catch { return [] }
}

function terminateGroup(proc) {
  if (!proc?.pid) return undefined;
  const members = groupMembers(proc.pid);
  try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch {} }
  const force = setTimeout(() => {
    for (const member of members) {
      if (processIdentity(member.pid)?.started !== member.started) continue;
      try { process.kill(member.pid, 'SIGKILL') } catch {}
    }
  }, 1_000);
  force.unref();
  return force;
}

export function shell(command, cwd, input, timeoutMs = 120_000) {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let proc;
    try {
      proc = spawn('/bin/bash', ['-lc', command], {
        cwd: cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
    } catch (error) {
      finish({ code: 127, stdout: '', stderr: `Spawn error: ${ error.message }` });
      return;
    }
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    timer = setTimeout(() => {
      timedOut = true;
      terminateGroup(proc);
    }, Math.max(1, Number(timeoutMs) || 120_000));
    proc.stdout.on('data', chunk => appendBounded(stdout, chunk, stdoutState));
    proc.stderr.on('data', chunk => appendBounded(stderr, chunk, stderrState));
    proc.once('error', error => finish({ code: 127, stdout: '', stderr: `Spawn error: ${ error.message }` }));
    proc.once('close', code => {
      const out = Buffer.concat(stdout).toString('utf8') + (stdoutState.truncated ? '\n[output truncated]' : '');
      const err = Buffer.concat(stderr).toString('utf8') + (stderrState.truncated ? '\n[output truncated]' : '');
      finish({ code: timedOut ? -1 : (code ?? 1), stdout: out, stderr: timedOut ? `${ err }${ err ? '\n' : '' }Command timed out` : err });
    });
    proc.stdin.on('error', () => {});
    if (input) proc.stdin.write(String(input), () => {});
    proc.stdin.end();
  });
}

function emit(data) {
  process.stdout.write(data);
  const lines = `${ outputLineBuffer }${ String(data) }`.split('\n');
  outputLineBuffer = lines.pop() ?? '';
  if (outputLineBuffer.length > MAX_OUTPUT_BYTES) outputLineBuffer = outputLineBuffer.slice(-MAX_OUTPUT_BYTES);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (provider === 'codex' && codexSteersAwaitingActivity.length && event.type !== 'sulla.steer.ack') {
        for (const id of codexSteersAwaitingActivity.splice(0)) {
          process.stdout.write(`${ JSON.stringify({ type: 'sulla.steer.ack', id }) }\n`);
        }
      }
      if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
      if (event.session_id) threadId = event.session_id;
      if (provider === 'claude-code' && event.type === 'user' && event.isReplay) {
        const echoed = typeof event.message?.content === 'string'
          ? event.message.content
          : Array.isArray(event.message?.content)
            ? event.message.content.map(block => block?.text ?? '').join('')
            : '';
        const index = claudeSteersInFlight.findIndex(entry => entry.message === echoed);
        if (index >= 0) {
          const [consumed] = claudeSteersInFlight.splice(index, 1);
          for (const id of consumed.ids) process.stdout.write(`${ JSON.stringify({ type: 'sulla.steer.ack', id }) }\n`);
        }
      }
      if (provider === 'claude-code' && event.type === 'result') {
        if (queuedSteers.length > 0 && child && !child.stdin.destroyed && !child.stdin.writableEnded) {
          flushClaudeSteers();
        }
        if (!claudeSteersInFlight.length) {
          clearTimeout(claudeResultGrace);
          claudeResultGrace = setTimeout(() => {
            if (!queuedSteers.length && !claudeSteersInFlight.length) child?.stdin.end();
          }, 250);
        }
      }
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
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') process.stderr.write(`codex stdin: ${ error.message }\n`) });
  child.stdin.end(prompt);
  child.once('close', code => {
    child = null;
    if (stopping) return process.exit(code || 130);
    if (queuedSteers.length > 0 && threadId) {
      const steers = queuedSteers.splice(0);
      const prompt = steers.map(entry => entry.message).join('\n\n');
      codexSteersAwaitingActivity = steers.map(entry => entry.id);
      launchCodex(prompt, true);
      return;
    }
    process.exit(code ?? 1);
  });
}

function launchClaude(prompt, resume = false, awaitingReplay = null) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--dangerously-skip-permissions', '--input-format', 'stream-json', '--replay-user-messages',
    '--append-system-prompt-file', instructions];
  if (resume && threadId) args.push('--resume', threadId);
  if (model) args.push('--model', model);
  child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', emit);
  child.stderr.on('data', data => process.stderr.write(data));
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') process.stderr.write(`claude stdin: ${ error.message }\n`) });
  child.once('close', code => {
    child = null;
    clearTimeout(claudeResultGrace);
    if (stopping) return process.exit(code || 130);
    const pending = [...claudeSteersInFlight.splice(0), ...queuedSteers.splice(0)];
    if (pending.length && threadId) {
      const combined = { ids: pending.flatMap(entry => entry.ids), message: pending.map(entry => entry.message).join('\n\n') };
      return launchClaude(combined.message, true, combined);
    }
    process.exit(code ?? 1);
  });
  if (awaitingReplay) claudeSteersInFlight.push(awaitingReplay);
  child.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) }\n`);
}

function flushClaudeSteers() {
  if (!child || child.stdin.destroyed || child.stdin.writableEnded) return;
  clearTimeout(claudeResultGrace);
  for (const steer of queuedSteers.splice(0)) {
    child.stdin.write(`${ JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: steer.message }] } }) }\n`);
    claudeSteersInFlight.push({ ids: [steer.id], message: steer.message });
  }
}

function start(prompt) {
  if (started) return;
  started = true;
  if (provider === 'claude-code') launchClaude(prompt);
  else if (provider === 'codex') launchCodex(prompt);
  else throw new Error(`Unsupported SULLA_AGENT_PROVIDER=${ provider }`);
}

function steer(message, id) {
  if (!child || !message) return;
  if (provider === 'claude-code') {
    queuedSteers.push({ id, ids: [id], message });
    flushClaudeSteers();
    return;
  }
  queuedSteers.push({ id, ids: [id], message });
  if (threadId) child.kill('SIGINT');
}

function cancel() {
  stopping = true;
  if (!child) process.exit(130);
  terminateGroup(child);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let command;
    try { command = JSON.parse(line) } catch { return }
    if (command.type === 'start') start(String(command.prompt ?? ''));
    else if (command.type === 'steer') steer(String(command.message ?? ''), String(command.id ?? ''));
    else if (command.type === 'cancel') cancel();
  });
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
}
