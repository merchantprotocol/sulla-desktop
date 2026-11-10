// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { HeuristicEndOfTurnDetector, TurnBuffer } from './ConversationTurnPolicy';
import { describe, expect, it } from 'vitest';

describe('voice turn policy primitives', () => {
  it('preserves transcript segment order', () => {
    const buffer = new TurnBuffer(); buffer.append('first'); buffer.append('second');
    expect(buffer.text).toBe('first second');
  });
  it('extends hold for an unfinished phrase', () => {
    expect(new HeuristicEndOfTurnDetector().delayMs('and', 700)).toBe(1400);
  });
});
