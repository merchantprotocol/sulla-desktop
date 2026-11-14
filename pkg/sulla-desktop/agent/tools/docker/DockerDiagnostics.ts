// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface DockerStatsRow { id: string; name: string; cpuPercent: number; memoryUsage: string; memoryLimit: string; memoryPercent: number; networkIO: string; blockIO: string; pids: number }

export class DockerDiagnostics {
  buildStatsArgs(containers: string[] = []): string[] {
    return ['stats', '--no-stream', '--format', '{{json .}}', ...containers];
  }

  parseStats(output: string): DockerStatsRow[] {
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const row = JSON.parse(line);
      const numeric = (value: unknown) => Number.parseFloat(String(value ?? '').replace('%', '').replace(/,/g, '')) || 0;
      const name = String(row.Name ?? row.name ?? '');
      return { id: String(row.ID ?? row.Id ?? row.id ?? ''), name, cpuPercent: numeric(row.CPUPerc ?? row.CPU ?? row.cpu), memoryUsage: String(row.MemUsage ?? row.Memory ?? ''), memoryLimit: String(row.MemLimit ?? ''), memoryPercent: numeric(row.MemPerc ?? row.memoryPercent), networkIO: String(row.NetIO ?? row.NetworkIO ?? ''), blockIO: String(row.BlockIO ?? ''), pids: numeric(row.PIDs ?? row.Pids ?? row.pids) };
    });
  }
  sortStats(rows: DockerStatsRow[], sort?: string, limit?: number): DockerStatsRow[] {
    const key = sort === 'cpu' ? 'cpuPercent' : sort === 'mem' ? 'memoryPercent' : sort === 'pids' ? 'pids' : undefined;
    const sorted = key ? [...rows].sort((a,b) => b[key] - a[key]) : [...rows];
    return Number.isFinite(limit) && Number(limit) > 0 ? sorted.slice(0, Math.floor(Number(limit))) : sorted;
  }
  healthFlags(state: any): string[] {
    const flags: string[] = [];
    const status = String(state?.State?.Status ?? 'unknown').toLowerCase();
    const health = String(state?.State?.Health?.Status ?? '').toLowerCase();
    if (status === 'restarting') flags.push('restarting');
    if (health === 'unhealthy') flags.push('unhealthy');
    if (state?.State?.OOMKilled === true) flags.push('oom-killed');
    if (status === 'exited' && Number(state?.State?.ExitCode) !== 0) flags.push('exited-nonzero');
    return flags;
  }
}
