// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile } from 'node:child_process';
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

  async dispose(): Promise<void> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

describe('agent-side sulla remote routing', () => {
  const harness = new SullaRemoteRoutingHarness();
  afterEach(() => harness.dispose());

  it('routes desktop/snapshot to the internal tool API when live catalog help is unavailable', async() => {
    // risk: privacy — proxy fallback bypasses DesktopTargetPolicy entirely.
    const request = await harness.route('desktop/snapshot');
    expect(request).toContain('/v1/tools/internal/desktop/snapshot/call');
    expect(request).not.toContain('/v1/proxy/desktop/snapshot');
  });
});
