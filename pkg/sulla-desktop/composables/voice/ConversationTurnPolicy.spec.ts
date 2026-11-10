// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { TurnBuffer } from './ConversationTurnPolicy';
import { describe, expect, it } from 'vitest';

describe('TurnBuffer', () => {
  it('risk: data accuracy — preserves every transcript segment in order', () => {
    const buffer = new TurnBuffer(); buffer.append('first'); buffer.append('second');
    expect(buffer.text).toBe('first second');
  });
});
