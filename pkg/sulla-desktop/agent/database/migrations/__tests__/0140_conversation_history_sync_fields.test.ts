/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0140_conversation_history_sync_fields';

describe('0140 conversation history sync fields migration', () => {
  it('adds mobile ordering timestamps for pin and archive sync', () => {
    expect(up).toContain('pinned_at TIMESTAMP WITH TIME ZONE');
    expect(up).toContain('archived_at TIMESTAMP WITH TIME ZONE');
    expect(up).toContain('unread_count INTEGER NOT NULL DEFAULT 0');
    expect(up).toContain('updated_at TIMESTAMP WITH TIME ZONE');
  });

  it('drops exactly what it adds', () => {
    for (const column of ['pinned_at', 'archived_at', 'unread_count', 'updated_at']) expect(down).toContain(`DROP COLUMN IF EXISTS ${ column }`);
  });
});
