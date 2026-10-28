// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { refreshRetryDelayMs } from '../oauthRefreshRetry';

describe('refreshRetryDelayMs', () => {
  it('backs off exponentially from 60s and caps at 30 minutes', () => {
    expect(refreshRetryDelayMs(1)).toBe(60_000);
    expect(refreshRetryDelayMs(2)).toBe(120_000);
    expect(refreshRetryDelayMs(5)).toBe(960_000);
    expect(refreshRetryDelayMs(6)).toBe(1_800_000);
    expect(refreshRetryDelayMs(50)).toBe(1_800_000);
  });
});
