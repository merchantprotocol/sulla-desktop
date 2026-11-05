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
    const command = new AgentExecDockerPolicy().apply('docker run -d nginx', {}, identity);
    expect(command).toContain("'com.sulla.owner=agent'");
    expect(command).toContain("'com.sulla.job-id=job-7'");
  });

  it('refuses compose up when the resolved compose config declares a restart policy', () => {
    // risk: compose services with restart: unless-stopped survive every reboot
    shell = new FakeDockerShell('services:\n  web:\n    image: nginx\n    restart: unless-stopped\n');
    const result = shell.run(new AgentExecDockerPolicy().apply('docker compose -p preview up -d', {}, identity));
    expect(result.code).toBe(64);
    expect(result.calls.some(call => / up -d$/.test(call))).toBe(false);
  });

  it('lets a compose up without restart policies run normally', () => {
    // risk: the guard blocks the normal preview workflow agents rely on
    shell = new FakeDockerShell('services:\n  web:\n    image: nginx\n');
    const result = shell.run(new AgentExecDockerPolicy().apply('docker compose -p preview up -d', {}, identity));
    expect(result.code).toBe(0);
    expect(result.calls).toContain('compose -p preview up -d');
  });

  it('allows a restartable compose stack only with persistent:true and a reason', () => {
    shell = new FakeDockerShell('services:\n  web:\n    image: nginx\n    restart: always\n');
    expect(() => new AgentExecDockerPolicy().apply('docker compose up -d', { persistent: true }, identity)).toThrow(/reason/);
    const result = shell.run(new AgentExecDockerPolicy().apply('docker compose up -d', { persistent: true, reason: 'human asked for a long-lived service' }, identity));
    expect(result.code).toBe(0);
    expect(result.calls).toContain('compose up -d');
  });
});
