// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentExecDockerPolicy } from '@pkg/agent/tools/docker/AgentExecDockerPolicy';

/** Runs a rewritten command in a real shell with a fake docker binary that only records calls. */
class FakeDockerShell {
  readonly dir = mkdtempSync(join(tmpdir(), 'agent-exec-docker-'));
  readonly log = join(this.dir, 'calls.log');

  constructor(composeConfig: string) {
    writeFileSync(join(this.dir, 'config.yml'), composeConfig);
    const fake = join(this.dir, 'docker');
    writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${ this.log }"\ncase "$*" in *" config"*) cat "${ join(this.dir, 'config.yml') }";; esac\n`);
    chmodSync(fake, 0o755);
  }

  run(command: string): { code: number; calls: string[] } {
    let code = 0;
    try {
      execFileSync('sh', ['-c', command], { env: { ...process.env, PATH: `${ this.dir }:${ process.env.PATH }` }, stdio: 'pipe' });
    } catch (error: any) {
      code = error.status ?? 1;
    }
    let calls: string[] = [];
    try { calls = readFileSync(this.log, 'utf8').trim().split('\n') } catch { /* no calls */ }
    return { code, calls };
  }

  dispose(): void { rmSync(this.dir, { recursive: true, force: true }) }
}

describe('AgentExecDockerPolicy', () => {
  const identity = { jobId: 'job-7', agentId: 'worker' };
  let shell: FakeDockerShell | null = null;
  afterEach(() => { shell?.dispose(); shell = null });

  it('injects ownership labels into docker run issued through exec', () => {
    // risk: shell-launched containers bypass the catalog tool retention policy
    const { command, labels } = new AgentExecDockerPolicy().apply('docker run -d nginx', {}, identity);
    expect(command).toContain("'com.sulla.owner=agent'");
    expect(command).toContain("'com.sulla.job-id=job-7'");
    expect(labels).toMatchObject({ 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'job-7' });
  });

  it('labels every run and create launch in one command, including the docker container forms', () => {
    // risk: a second launch in a chained command, or the container run/create spelling, escapes ownership labels and the reaper
    const { command } = new AgentExecDockerPolicy().apply(
      'docker run -d a && docker container run -d b; docker create c && docker container create d', {}, identity);
    expect(command.match(/'com\.sulla\.owner=agent'/g)).toHaveLength(4);
    for (const launch of ['docker run --label', 'docker container run --label', 'docker create --label', 'docker container create --label']) {
      expect(command).toContain(launch);
    }
  });

  it('refuses restart policies on run, create and docker update unless persistent with a reason', () => {
    // risk: --restart set on a later launch or added afterwards with docker update resurrects forgotten previews on every boot
    const policy = new AgentExecDockerPolicy();
    for (const cmd of [
      'docker run -d a && docker run --restart unless-stopped -d b',
      'docker container create --restart=always c',
      'docker update --restart=unless-stopped preview',
      'docker container update --restart always preview',
    ]) {
      expect(() => policy.apply(cmd, {}, identity), cmd).toThrow(/restart policies are refused/);
    }
    expect(policy.apply('docker update --restart=no preview', {}, identity).command).toBe('docker update --restart=no preview');
    expect(() => policy.apply('docker update --restart=always db', { persistent: true }, identity)).toThrow(/reason/);
    expect(policy.apply('docker update --restart=always db', { persistent: true, reason: 'local database' }, identity).command)
      .toBe('docker update --restart=always db');
  });

  it('refuses compose up when the resolved compose config declares a restart policy', () => {
    // risk: compose services with restart: unless-stopped survive every reboot
    shell = new FakeDockerShell('services:\n  web:\n    image: nginx\n    restart: unless-stopped\n');
    const result = shell.run(new AgentExecDockerPolicy().apply('docker compose -p preview up -d', {}, identity).command);
    expect(result.code).toBe(64);
    expect(result.calls.some(call => / up -d$/.test(call))).toBe(false);
  });

  it('lets a compose up without restart policies run normally', () => {
    // risk: compose previews bypass ownership labels and become invisible to retention
    shell = new FakeDockerShell('services:\n  web:\n    image: nginx\n');
    const result = shell.run(new AgentExecDockerPolicy().apply('docker compose -p preview up -d', {}, identity).command);
    expect(result.code).toBe(0);
    expect(result.calls).toContain('compose -p sulla-agent-job-7-preview config --services');
    expect(result.calls.some(call => call.includes('compose -p sulla-agent-job-7-preview -f /mnt/data/sulla/runtime/agents/job-7/compose/sulla-agent-job-7-preview.override.yml up -d'))).toBe(true);
  });

  it('keeps an already job-scoped compose project and injects every ownership label through an override', () => {
    // risk: generated compose containers are unlabelled, reaped unsafely, or collide with an unrelated project
    const result = new AgentExecDockerPolicy().apply('docker compose -p sulla-agent-job-7-preview -f compose.yml up -d', {}, identity);
    expect(result.command).toContain("-p 'sulla-agent-job-7-preview' -f compose.yml config --services");
    expect(result.command).toContain('com.sulla.owner');
    expect(result.command).toContain('com.sulla.job-id');
    expect(result.command).toContain("-f \"$override\" up -d");
    expect(result.command).not.toContain('sulla-agent-job-7-sulla-agent-job-7-preview');
    expect(result.labels).toMatchObject({ 'com.sulla.owner': 'agent', 'com.sulla.job-id': 'job-7' });
  });

  it('allows a restartable compose stack only with persistent:true and a reason', () => {
    shell = new FakeDockerShell('services:\n  web:\n    image: nginx\n    restart: always\n');
    expect(() => new AgentExecDockerPolicy().apply('docker compose up -d', { persistent: true }, identity)).toThrow(/reason/);
    const result = shell.run(new AgentExecDockerPolicy().apply('docker compose up -d', { persistent: true, reason: 'human asked for a long-lived service' }, identity).command);
    expect(result.code).toBe(0);
    expect(result.calls).toContain('compose up -d');
  });
});
