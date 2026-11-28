// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import toolPlacements from '../../../../../resources/tool-placements.json';
import { DockerDiagnostics } from '../../tools/docker/DockerDiagnostics';
import { DockerExecWorker } from '../../tools/docker/docker_exec';

describe('DockerDiagnostics', () => {
  const diagnostics = new DockerDiagnostics();

  it('builds a one-shot stats request with optional container filters', () => {
    // risk: accuracy — stats must be sampled once and target only requested containers.
    expect(diagnostics.buildStatsArgs(['api', 'worker'])).toEqual(['stats', '--no-stream', '--format', '{{json .}}', 'api', 'worker']);
  });

  it('parses and sorts stats numerically before applying a limit', () => {
    // risk: accuracy — resource ranking must not sort percentages lexically.
    const rows = diagnostics.parseStats([
      JSON.stringify({ ID: '1', Name: 'low', CPUPerc: '9.0%', MemUsage: '1MiB / 2MiB', MemPerc: '10%', NetIO: '1kB / 2kB', BlockIO: '0B / 0B', PIDs: '2' }),
      JSON.stringify({ ID: '2', Name: 'high', CPUPerc: '80.0%', MemUsage: '2MiB / 2MiB', MemPerc: '90%', NetIO: '2kB / 3kB', BlockIO: '1kB / 0B', PIDs: '20' }),
    ].join('\n'));
    expect(diagnostics.sortStats(rows, 'cpu', 1).map(row => row.name)).toEqual(['high']);
    expect(diagnostics.sortStats(rows, 'pids')[0].pids).toBe(20);
  });

  it('flags unhealthy, restarting, OOM-killed and nonzero-exit states', () => {
    // risk: availability — unhealthy or repeatedly crashing containers must be surfaced.
    expect(diagnostics.healthFlags({ State: { Status: 'running', Health: { Status: 'unhealthy' } } })).toContain('unhealthy');
    expect(diagnostics.healthFlags({ State: { Status: 'restarting' } })).toContain('restarting');
    expect(diagnostics.healthFlags({ State: { Status: 'exited', OOMKilled: true, ExitCode: 137 } })).toEqual(expect.arrayContaining(['oom-killed', 'exited-nonzero']));
  });

  it('refuses exec into vault or wallet containers without invoking Docker', async () => {
    // risk: privacy/security — command execution must never inspect sealed vault or wallet data.
    const worker = new DockerExecWorker() as any;
    for (const container of ['sulla_vault', 'wallet-service', 'WALLET_backup']) {
      const result = await worker._validatedCall({ container, command: 'cat /sealed/data' });
      expect(result.successBoolean).toBe(false);
      expect(result.responseString).toContain('vault and wallet containers are sealed');
    }
  });

  it('keeps docker_exec relayable to the Sulla runtime VM', () => {
    // risk: execution — agent-container calls must route to Desktop instead of a missing local Docker CLI.
    expect(toolPlacements.tools['docker/docker_exec']).toMatchObject({
      placements: ['desktop'],
      relayable: true,
    });
    expect(toolPlacements.tools['docker/docker_run'].relayable).toBe(false);
    expect(toolPlacements.tools['docker/docker_build'].relayable).toBe(false);
  });

  it('passes the user command as one argv to sh -c via the Docker worker', () => {
    // risk: execution — keep docker on the host side and preserve compound shell commands in-container.
    const worker = new DockerExecWorker() as unknown as { buildExecArgs(container: string, command: string): string[] };
    expect(worker.buildExecArgs('api', 'printf "%s" "a b" && ls')).toEqual(['exec', 'api', 'sh', '-c', 'printf "%s" "a b" && ls']);
  });
});
