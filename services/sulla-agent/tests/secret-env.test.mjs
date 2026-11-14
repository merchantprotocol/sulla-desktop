// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(serviceDir, '..', 'secret-env.sh');

class CliSessionRequest {
  constructor(processEnvironment, secretDirectory) {
    this.processEnvironment = processEnvironment;
    this.secretDirectory = secretDirectory;
  }

  send() {
    const script = `. "${ helperPath }"; load_sulla_tool_session "$1"; printf 'X-Sulla-Tool-Session: %s' "$SULLA_TOOL_SESSION"`;
    const result = spawnSync('sh', ['-c', script, 'test', this.secretDirectory], {
      encoding: 'utf8', env: this.processEnvironment,
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }
}

test('CLI request keeps process session A when shared secret file contains B', t => {
  // risk: tenant/session isolation; a shared file must never attribute a request to another chat.
  const secretDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-session-'));
  t.after(() => fs.rmSync(secretDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(secretDirectory, 'SULLA_TOOL_SESSION'), 'session-B');
  const request = new CliSessionRequest({ ...process.env, SULLA_TOOL_SESSION: 'session-A' }, secretDirectory);
  assert.equal(request.send(), 'X-Sulla-Tool-Session: session-A');
});
