// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { SileroChunkGate } from './SileroChunkGate';

describe('SileroChunkGate', () => {
  it('rejects noise and admits a chunk with at least 20% speech frames', () => {
    const gate = new SileroChunkGate();
    expect(gate.shouldForward([0.1, 0.2, 0.3, 0.1, 0.4])).toBe(false);
    expect(gate.shouldForward([0.7, 0.1, 0.8, 0.2, 0.1])).toBe(true);
  });

  it('keeps the onset pre-roll and two trailing chunks, then closes', () => {
    const gate = new SileroChunkGate();
    expect(gate.shouldForward([0.8])).toBe(true);
    expect(gate.shouldForward([0.1])).toBe(true);
    expect(gate.shouldForward([0.1])).toBe(true);
    expect(gate.shouldForward([0.1])).toBe(false);
  });
});
