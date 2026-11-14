// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

export class DockerVmSnapshotWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(): Promise<ToolResponse> {
    const script = `printf 'LOAD '; cat /proc/loadavg
printf 'NPROC '; getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo
printf 'MEM\\n'; grep -E '^(MemTotal|MemAvailable|MemFree|SwapTotal|SwapFree):' /proc/meminfo
printf 'DISK\\n'; df -P -B1 2>/dev/null || df -Pk
printf 'CPU\\n'; ps -eo pid=,etime=,rss=,pcpu=,stat=,comm= --sort=-pcpu 2>/dev/null | head -n 20
printf 'RSS\\n'; ps -eo pid=,etime=,rss=,pcpu=,stat=,comm= --sort=-rss 2>/dev/null | head -n 20
printf 'COUNTS\\n'; ps -eo comm= 2>/dev/null | sort | uniq -c
printf 'ZOMBIES '; ps -eo stat= 2>/dev/null | grep -c '^Z' || true`;
    const response = await runCommand('sh', ['-c', script], { runInGuest: true, timeoutMs: 30000, maxOutputChars: 120000 });
    if (response.exitCode !== 0) return { successBoolean: false, responseString: response.stderr || response.stdout };
    const lines = response.stdout.split(/\r?\n/);
    const slice = (start: string, end: string) => lines.slice(lines.indexOf(start) + 1, lines.indexOf(end));
    const parseProcess = (line: string) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), etime: match[2], rssKb: Number(match[3]), cpuPercent: Number(match[4]), state: match[5], comm: match[6] } : null;
    };
    const processNameCounts: Record<string, number> = {};
    for (const line of slice('COUNTS', 'ZOMBIES')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) processNameCounts[match[2]] = Number(match[1]);
    }
    const result = {
      loadavg: lines.find(line => line.startsWith('LOAD '))?.slice(5),
      nproc: Number(lines.find(line => line.startsWith('NPROC '))?.slice(6)),
      meminfo: slice('MEM', 'DISK'),
      diskUsage: slice('DISK', 'CPU'),
      topCpu: slice('CPU', 'RSS').map(parseProcess).filter(Boolean),
      topRss: slice('RSS', 'COUNTS').map(parseProcess).filter(Boolean),
      processNameCounts,
      zombieCount: Number(lines.find(line => line.startsWith('ZOMBIES '))?.slice(8)) || 0,
    };
    return { successBoolean: true, responseString: JSON.stringify(result, null, 2), result };
  }
}
