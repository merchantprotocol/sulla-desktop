// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { GitTraceSummary } from '../../../../tools/github/gitTraceSummary';

describe('GitTraceSummary', () => {
  it('retains HTTP diagnostics while stripping broker tokens and credential headers', () => {
    // risk: private repository credentials must never be returned in tool output
    const token = 'secret-broker-segment';
    const trace = [
      `=> Send header: GET http://host.sulla.internal:4123/${ token }/acme/repo.git/info/refs?service=git-upload-pack`,
      '> Authorization: Basic abc123',
      '> Cookie: session=private',
      '< HTTP/2 200',
      '< content-type: application/x-git-upload-pack-advertisement',
      '== Info: transfer closed after 12345 bytes received',
    ].join('\n');
    const summary = GitTraceSummary.redact(trace, `http://host.sulla.internal:4123/${ token }/acme/repo.git`);
    expect(summary).toContain('HTTP/2 200');
    expect(summary).toContain('content-type');
    expect(summary).toContain('12345 bytes');
    expect(summary).not.toContain(token);
    expect(summary).not.toContain('abc123');
    expect(summary).not.toContain('session=private');
  });
});
