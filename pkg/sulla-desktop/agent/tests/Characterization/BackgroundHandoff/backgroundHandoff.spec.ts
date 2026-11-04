// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, safeStorage: {} }));
let awaitBackgroundHandoff: typeof import('../../../languagemodels/ClaudeCodeService').awaitBackgroundHandoff;
beforeAll(async () => {
  process.env.XDG_DATA_HOME = tmpdir();
  ({ awaitBackgroundHandoff } = await import('../../../languagemodels/ClaudeCodeService'));
});
import { CliHandoffFailure } from '../../../languagemodels/cliFaultRecovery';
import { classifyLLMFailure } from '../../../languagemodels/providerRecovery';
import { buildContainerProviderKillScript } from '../../../services/containerProviderKill';

const exec = promisify(execFile);
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children) { try { child.kill('SIGKILL') } catch {} }
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function startTime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
async function alive(pid: number): Promise<boolean> {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z') } catch { return false }
}
async function waitUntil(test: () => Promise<boolean>, timeout = 4_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('condition timed out');
}

describe('BL-042 background process handoff', () => {
  it('kills only the recorded CLI tree under POSIX /bin/sh', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sulla-kill-tree-')); dirs.push(dir);
    const keeper = spawn('/bin/sh', ['-c', 'exec sleep 120']); children.push(keeper);
    const unrelated = spawn('/bin/sh', ['-c', 'exec sleep 120']); children.push(unrelated);
    const target = spawn('/bin/sh', ['-c', `sleep 120 & a=$!; /bin/sh -c 'sleep 120 & wait' & b=$!; printf '%s %s\\n' "$a" "$b" > '${dir}/children'; wait`]); children.push(target);
    await waitUntil(async () => { try { return (await readFile(path.join(dir, 'children'), 'utf8')).trim().split(/\s+/).length === 2 } catch { return false } });
    const targetPid = target.pid!; const descendants = (await readFile(path.join(dir, 'children'), 'utf8')).trim().split(/\s+/).map(Number);
    const record = path.join(dir, 'target.pid'); await writeFile(record, `${targetPid} ${await startTime(targetPid)}\n`);
    await exec('/bin/sh', ['-c', buildContainerProviderKillScript(), 'kill-helper', record, 'TERM']);
    await exec('/bin/sh', ['-c', buildContainerProviderKillScript(), 'kill-helper', record, 'KILL']);
    await waitUntil(async () => !(await alive(targetPid)) && (await Promise.all(descendants.map(alive))).every(x => !x));
    expect(await alive(keeper.pid!)).toBe(true);
    expect(await alive(unrelated.pid!)).toBe(true);
    expect([targetPid, ...descendants]).not.toContain(1);
  });

  it('never signals a PID whose recorded start time no longer matches', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sulla-kill-reuse-')); dirs.push(dir);
    const process = spawn('/bin/sh', ['-c', 'exec sleep 120']); children.push(process);
    const record = path.join(dir, 'target.pid'); await writeFile(record, `${process.pid} 1\n`);
    await exec('/bin/sh', ['-c', buildContainerProviderKillScript(), 'kill-helper', record, 'KILL']);
    expect(await alive(process.pid!)).toBe(true);
  });

  it('waits for stop confirmation, caps the wait, and Stop aborts it', async () => {
    vi.useFakeTimers();
    let confirm!: () => void;
    const confirmed = new Promise<void>(resolve => { confirm = resolve });
    const pending = awaitBackgroundHandoff(confirmed);
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false; pending.finally(() => { settled = true }); await Promise.resolve();
    expect(settled).toBe(false);
    confirm(); expect(await pending).toBe('stopped');

    const capped = awaitBackgroundHandoff(new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(15_000); expect(await capped).toBe('timed_out');

    const controller = new AbortController();
    const aborted = awaitBackgroundHandoff(new Promise<void>(() => {}), controller.signal);
    controller.abort(); await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('tags post-handoff faults as infrastructure rather than provider failures', () => {
    const failure = new CliHandoffFailure('transport', new Error('remote stop unconfirmed'));
    expect(failure).toMatchObject({ code: 'SULLA_INFRA', cliHandoffFailure: true });
    expect(classifyLLMFailure(failure).kind).toBe('infrastructure');
  });
});
