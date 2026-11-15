// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { runCommand } from '@pkg/agent/tools/util/CommandRunner';
import {
  decideHeadlessProcessReap,
  isHeadlessBrowser,
  isProtectedProcess,
  parseProcessCpuTime,
} from './HeadlessBrowserReaperPolicy';

const SAMPLE_INTERVAL_MS = 60_000;
const TERM_GRACE_MS = 10_000;

interface ProcessRecord {
  pid: number;
  ppid: number;
  cpuSeconds: number;
  command: string;
  args: string;
}

type ProcessTarget = 'host' | 'vm';

interface CpuObservation {
  totalCpuSeconds: number;
  unchangedSince: number;
  command: string;
  args: string;
}

interface ProcessCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class HeadlessBrowserReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly observations = new Map<string, CpuObservation>();

  constructor(
    private readonly command: (command: string, args: string[], target: ProcessTarget) => Promise<ProcessCommandResult> = (name, args, target) => runCommand(name, args, { runInGuest: target === 'vm', timeoutMs: 20_000 }),
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.observations.clear();
  }

  async sample(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all((['host', 'vm'] as const).map(target => this.sampleTarget(target)));
    } catch (error) {
      console.warn(`[HeadlessBrowserReaper] Process scan failed: ${ error instanceof Error ? error.message : String(error) }`);
    } finally {
      this.running = false;
    }
  }

  private async sampleTarget(target: ProcessTarget): Promise<void> {
    const listing = await this.command('ps', [process.platform === 'darwin'
      ? '-axo pid=,ppid=,time=,args='
      : '-eo pid=,ppid=,time=,args='], target);
    if (listing.exitCode !== 0) throw new Error(listing.stderr || `ps exited ${ listing.exitCode } (${ target })`);

    const processes = this.parseProcessList(listing.stdout);
    const byPid = new Map(processes.map(proc => [proc.pid, proc]));
    const children = new Map<number, number[]>();
    for (const proc of processes) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);

    const roots = processes.filter(proc => isHeadlessBrowser(proc) && !this.hasHeadlessAncestor(proc, byPid));
    const seen = new Set<string>();
    const sampledAt = this.now();
    for (const root of roots) {
      const pids = this.processTree(root.pid, children);
      const totalCpuSeconds = pids.reduce((total, pid) => total + (byPid.get(pid)?.cpuSeconds ?? 0), 0);
      const key = `${ target }:${ root.pid }`;
      seen.add(key);
      const previous = this.observations.get(key);
      const unchangedSince = previous && previous.totalCpuSeconds === totalCpuSeconds && previous.command === root.command && previous.args === root.args
        ? previous.unchangedSince
        : sampledAt;
      this.observations.set(key, { totalCpuSeconds, unchangedSince, command: root.command, args: root.args });

      const parentExists = byPid.has(root.ppid);
      const orphaned = !parentExists || root.ppid === 1;
      const idleForMs = sampledAt - unchangedSince;
      const decision = decideHeadlessProcessReap({
        candidate: true,
        protectedProcess: isProtectedProcess(root),
        orphaned,
        idleForMs,
      });
      if (decision.reap) await this.terminateTree(target, root.pid, pids, Math.round(idleForMs / 1000), decision.reason!);
    }
    for (const key of this.observations.keys()) if (key.startsWith(`${ target }:`) && !seen.has(key)) this.observations.delete(key);
  }

  private parseProcessList(output: string): ProcessRecord[] {
    return output.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!match) return [];
      const [, pidText, ppidText, cpuTime, args] = match;
      const command = /^"([^"]+)"|^(\S+)/.exec(args)?.slice(1).find(Boolean) ?? '';
      return [{ pid: Number(pidText), ppid: Number(ppidText), cpuSeconds: parseProcessCpuTime(cpuTime), command, args }];
    });
  }

  private hasHeadlessAncestor(process: ProcessRecord, byPid: Map<number, ProcessRecord>): boolean {
    let parent = byPid.get(process.ppid);
    while (parent) {
      if (isHeadlessBrowser(parent)) return true;
      parent = byPid.get(parent.ppid);
    }
    return false;
  }

  private processTree(root: number, children: Map<number, number[]>): number[] {
    const pids: number[] = [];
    const pending = [root];
    while (pending.length) {
      const pid = pending.pop()!;
      pids.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return pids;
  }

  private async terminateTree(target: ProcessTarget, rootPid: number, pids: number[], ageSeconds: number, reason: string): Promise<void> {
    console.warn(`[HeadlessBrowserReaper] Reaping pid=${ rootPid } target=${ target } age=${ ageSeconds}s reason=${ reason }`);
    const pidList = pids.join(' ');
    const script = `for pid in ${ pidList }; do kill -TERM "$pid" 2>/dev/null || true; done; sleep ${ TERM_GRACE_MS / 1000 }; for pid in ${ pidList }; do kill -KILL "$pid" 2>/dev/null || true; done`;
    const result = await this.command('sh', ['-c', script], target);
    if (result.exitCode !== 0) console.warn(`[HeadlessBrowserReaper] Could not finish terminating pid=${ rootPid } target=${ target }: ${ result.stderr }`);
    this.observations.delete(`${ target }:${ rootPid }`);
  }
}

export const headlessBrowserReaper = new HeadlessBrowserReaper();
