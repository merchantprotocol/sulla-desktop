/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from '@jest/globals';

import { up } from '../0139_conversation_history_actions';

describe('0139 conversation history actions migration', () => {
  it('preserves legacy status-deleted rows as soft-deleted history', () => {
    expect(up).toContain("WHERE status = 'deleted' AND deleted_at IS NULL");
    expect(up).toContain('SET deleted_at = COALESCE(deleted_at, last_active_at, NOW())');
  });

  it('adds mobile ordering timestamps for pin and archive sync', () => {
    expect(up).toContain('pinned_at TIMESTAMP WITH TIME ZONE');
    expect(up).toContain('archived_at TIMESTAMP WITH TIME ZONE');
    expect(up).toContain('unread_count INTEGER NOT NULL DEFAULT 0');
    expect(up).toContain('updated_at TIMESTAMP WITH TIME ZONE');
  });
});
