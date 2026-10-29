// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AbortService } from '../../../services/AbortService';
import { childAbortForJob } from '../spawn_agent';

describe('async child abort ownership', () => {
  it('ignores a superseded parent turn but stops for the durable job abort', () => {
    const parent = new AbortService();
    const job = new AbortController();
    const child = childAbortForJob(true, parent, job.signal)!;

    parent.abort();
    expect(child.signal.aborted).toBe(false);
    job.abort();
    expect(child.signal.aborted).toBe(true);
  });

  it('keeps synchronous children coupled to the parent turn', () => {
    const parent = new AbortService();
    const child = childAbortForJob(false, parent, undefined)!;
    parent.abort();
    expect(child.signal.aborted).toBe(true);
  });
});
