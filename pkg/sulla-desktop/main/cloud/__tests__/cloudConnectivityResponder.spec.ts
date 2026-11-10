// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { CloudConnectivityResponder } from '../cloudConnectivityResponder';

describe('CloudConnectivityResponder', () => {
  it('on online, resumes both Files and Vault sync', () => {
    // risk: availability — going back online must push queued vault edits and retry backed-off Files.
    const files = { resumeAfterOffline: vi.fn() };
    const vault = { resumeAfterOffline: vi.fn() };
    new CloudConnectivityResponder({ files, vault }).handleOnline();
    expect(files.resumeAfterOffline).toHaveBeenCalledTimes(1);
    expect(vault.resumeAfterOffline).toHaveBeenCalledTimes(1);
  });
});
