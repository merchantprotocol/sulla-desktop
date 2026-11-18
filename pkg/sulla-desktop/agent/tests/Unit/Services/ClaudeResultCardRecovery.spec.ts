// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test' } } }));

import { CliFaultError } from '../../../languagemodels/cliFaultRecovery';
import { ClaudeCodeService } from '../../../languagemodels/ClaudeCodeService';

describe('Claude-backed background classification', () => {
  // risk: a cosmetic card classification burns provider retries and hides the real failure
  it('makes one CLI attempt when recovery is disabled for the result card', async() => {
    const service = new ClaudeCodeService();
    const runClaude = vi.fn(async() => { throw new CliFaultError('process_exit', 'CLI exited'); });
    (service as any).runClaude = runClaude;

    await expect((service as any).sendRawRequest([], { disableCliRecovery: true }))
      .rejects.toThrow(/recovery attempts/);
    expect(runClaude).toHaveBeenCalledTimes(1);
  });
});
