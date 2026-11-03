// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildContainerProviderKillScript } from '../containerProviderKill';

// The script reads /proc, so it only runs where /proc exists (Linux CI).
const linux = process.platform === 'linux' && fs.existsSync('/proc/self/stat');
const describeLinux = linux ? describe : describe.skip;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return !fs.readFileSync(`/proc/${ pid }/stat`, 'utf8').split(') ')[1]?.startsWith('Z');
  } catch {
    return false;
  }
};

const waitFor = async(check: () => boolean, ms = 3_000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  return check();
};

const starttime = (pid: number) => fs.readFileSync(`/proc/${ pid }/stat`, 'utf8').split(' ')[21];

describeLinux('container provider kill script', () => {
  let dir: string;
  const started: ChildProcess[] = [];

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-kill-')) });
  afterEach(() => {
    for (const child of started.splice(0)) { try { child.kill('SIGKILL') } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A provider stand-in with a background child and grandchild, as Bash run_in_background leaves. */
  async function providerWithBackgroundTasks() {
    const pidsFile = path.join(dir, 'pids');
    const provider = spawn('sh', ['-c', `sh -c 'sleep 60 & echo $! >> "$1"; wait' inner "$1" & echo $! >> "$1"; sleep 60 & echo $! >> "$1"; wait`, 'provider', pidsFile], { stdio: 'ignore' });
    started.push(provider);
    await waitFor(() => fs.existsSync(pidsFile) && fs.readFileSync(pidsFile, 'utf8').trim().split('\n').length >= 3);
    const descendants = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
    const pidFile = path.join(dir, 'provider.pid');
    fs.writeFileSync(pidFile, `${ provider.pid } ${ starttime(provider.pid!) }\n`);
    return { provider, descendants, pidFile };
  }

  const runScript = (pidFile: string, signal: 'TERM' | 'KILL') =>
    spawnSync('sh', ['-c', buildContainerProviderKillScript(), 'sulla-kill', pidFile, signal], { encoding: 'utf8' });

  it('signals the provider and every descendant, and nothing else', async() => {
    const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
    started.push(bystander);
    const { provider, descendants, pidFile } = await providerWithBackgroundTasks();

    expect(runScript(pidFile, 'TERM').status).toBe(0);

    expect(await waitFor(() => !alive(provider.pid!) && descendants.every(pid => !alive(pid)))).toBe(true);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it('ignores a pidfile whose process was replaced (PID reuse)', async() => {
    const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
    started.push(bystander);
    const pidFile = path.join(dir, 'stale.pid');
    fs.writeFileSync(pidFile, `${ bystander.pid } 1\n`);

    expect(runScript(pidFile, 'KILL').status).toBe(0);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it('never signals PID 1', () => {
    const pidFile = path.join(dir, 'init.pid');
    fs.writeFileSync(pidFile, `1 ${ starttime(1) }\n`);

    expect(runScript(pidFile, 'TERM').status).toBe(0);
  });
});
