// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE calendar_events 
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active' 
  CHECK (status IN ('active', 'cancelled', 'completed'));

  CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(status);
`;

export const down = `
  DROP INDEX IF EXISTS idx_calendar_events_status;
  ALTER TABLE calendar_events DROP COLUMN IF EXISTS status;
`;
