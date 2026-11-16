// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

describe('resuming a Claude session that cannot be resumed', () => {
  // risk: after a restart, a worker retried a session whose transcript was gone until
  // recovery gave up, so the agent failed instead of starting a fresh session
  it('treats a missing session like a locked one, so the turn retries fresh', async() => {
    const { resumeSessionUnusable } = await import('../../../languagemodels/ClaudeCodeService');
    expect(resumeSessionUnusable('No conversation found with session ID: d208e47d-c5fb-40cf-9d9b-d39684cde9fd')).toBe(true);
    expect(resumeSessionUnusable('Error: Session ID abc is already in use')).toBe(true);
  });

  it('does not treat other failures as a session problem', async() => {
    const { resumeSessionUnusable } = await import('../../../languagemodels/ClaudeCodeService');
    expect(resumeSessionUnusable('API Error: 529 overloaded')).toBe(false);
  });
});
