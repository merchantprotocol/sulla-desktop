// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);

class SullaRemoteRoutingHarness {
  private directory?: string;

  async route(command: string): Promise<string> {
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-routing-'));
    const capture = path.join(this.directory, 'request.txt');
    const curl = path.join(this.directory, 'curl');
    await writeFile(curl, `#!/bin/sh\ncase "$*" in\n  *'/v1/tools/help/desktop'*) exit 22 ;;\nesac\nprintf '%s\\n' "$*" > '${ capture }'\nprintf '{"success":true}'\n`);
    await chmod(curl, 0o755);
    await execute('sh', ['resources/darwin/bin/sulla', command, '{}'], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${ this.directory }:${ process.env.PATH }`, SULLA_TOOL_API_URL: 'http://tools.invalid' },
    });
    return await readFile(capture, 'utf8');
  }

  async reportProgressFromStdin(payload: string): Promise<{ request: string; body: string }> {
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-routing-'));
    const capture = path.join(this.directory, 'request.txt');
    const bodyCapture = path.join(this.directory, 'body.txt');
    const curl = path.join(this.directory, 'curl');
    await writeFile(curl, `#!/bin/sh\ncase "$*" in\n  *'%{http_code}'*'/v1/tools/help/agents'*) printf '200'; exit 0 ;;\n  *'/v1/tools/help/agents'*) printf 'Categories: agents\\n'; exit 0 ;;\nesac\nprintf '%s\\n' "$*" > '${ capture }'\ncat > '${ bodyCapture }'\nprintf '{"success":true}'\n`);
    await chmod(curl, 0o755);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('sh', ['resources/darwin/bin/sulla', 'agents/report_progress', '-'], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${ this.directory }:${ process.env.PATH }`, SULLA_TOOL_API_URL: 'http://tools.invalid' },
      });
      let stderr = '';
      child.stderr.on('data', chunk => stderr += String(chunk));
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`sulla exited ${ code }: ${ stderr }`)));
      child.stdin.end(payload);
    });
    return { request: await readFile(capture, 'utf8'), body: await readFile(bodyCapture, 'utf8') };
  }

  async localDesktop(pid: number, listenerPid: number): Promise<void> {
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'sulla-routing-'));
    const capture = path.join(this.directory, 'contacted');
    const shim = path.join(this.directory, 'darwin.sh');
    // Replace only Darwin system interfaces; execute the unmodified CLI with real kill -0.
    await writeFile(shim, `uname() { echo Darwin; }
function [ { case "$2" in /etc/sulla-env|/tmp/sulla-tools.sock) return 1;; esac; builtin [ "$@"; }
function /usr/bin/plutil {
  case "$2" in pid) echo ${ pid };; port) echo 30140;; token) echo synthetic;; *) return 1;; esac
}
function /usr/sbin/lsof { [[ "$*" == "-nP -i4TCP:30140 -sTCP:LISTEN -t" ]] && echo ${ listenerPid }; }
`);
    await writeFile(path.join(this.directory, 'curl'), `#!/bin/sh
touch "$HOME/contacted"
grep -qx 'Authorization: Bearer synthetic' <&3 && printf '%s' "$*"
`, { mode: 0o755 });
    const invoke = execute('bash', ['resources/darwin/bin/sulla', 'desktop/snapshot', '{}'], {
      env: {
        HOME:               this.directory,
        PATH:               `${ this.directory }:${ process.env.PATH }`,
        BASH_ENV:           shim,
        SULLA_TOOL_SESSION: 'synthetic',
      },
    });
    if (pid === process.pid && listenerPid === pid) {
      expect((await invoke).stdout).toContain('http://127.0.0.1:30140/v1/tools/internal/desktop/snapshot/call');
    } else {
      await expect(invoke).rejects.toMatchObject({ code: expect.any(Number) });
      await expect(readFile(capture)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }

  async dispose(): Promise<void> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

describe('agent-side sulla remote routing', () => {
  const harness = new SullaRemoteRoutingHarness();
  afterEach(() => harness.dispose());

  it.each([
    ['dead descriptor PID', 2147483647, process.pid],
    ['different listener', process.pid, process.ppid],
    ['live matching listener', process.pid, process.pid],
  ] as const)('authenticates the discovered endpoint: %s', async(_label, pid, listener) => {
    await harness.localDesktop(pid, listener);
  });

  it('routes desktop/snapshot to the internal tool API when live catalog help is unavailable', async() => {
    // risk: privacy — proxy fallback bypasses DesktopTargetPolicy entirely.
    const request = await harness.route('desktop/snapshot');
    expect(request).toContain('/v1/tools/internal/desktop/snapshot/call');
    expect(request).not.toContain('/v1/proxy/desktop/snapshot');
  });

  it('round-trips a quote-heavy report_progress payload from stdin', async() => {
    // risk: orchestration liveness — apostrophes and quotes in check-ins must not break shell parsing.
    const payload = JSON.stringify({ step: 'review', summary: `It's ready; reviewer said "ship it".` });
    const captured = await harness.reportProgressFromStdin(payload);
    expect(captured.request).toContain('/v1/tools/internal/agents/report_progress/call');
    expect(captured.request).toContain('--data-binary @-');
    expect(captured.body).toBe(payload);
  });
});
