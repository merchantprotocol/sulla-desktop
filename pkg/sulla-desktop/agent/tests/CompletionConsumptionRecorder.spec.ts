// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { CompletionConsumptionRecorder } from '../services/CompletionConsumptionRecorder';

describe('CompletionConsumptionRecorder', () => {
  it('releases injected notices when the first response aborts, but retains them after confirmation', async() => {
    // risk: data loss — an abort before the first model response must restore every injected completion.
    const recorder = new CompletionConsumptionRecorder();
    const entry = { jobId: 'job', taskIndex: 0, results: [] };
    const release = vi.fn();
    recorder.recordInjected([entry]);
    await recorder.releaseOnAbort(release);
    expect(release).toHaveBeenCalledWith(entry);

    recorder.recordInjected([entry]);
    recorder.confirmSeen();
    await recorder.releaseOnAbort(release);
    expect(release).toHaveBeenCalledOnce();
  });
});
