// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Metadata-only audit: never stores snapshots, typed text, or clipboard contents. */
export const up = `
  CREATE TABLE IF NOT EXISTS desktop_audit (
    id BIGSERIAL PRIMARY KEY,
    tool TEXT NOT NULL,
    target_app TEXT,
    action TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    duration_ms INTEGER NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_desktop_audit_executed ON desktop_audit(executed_at DESC);
`;

export const down = `DROP TABLE IF EXISTS desktop_audit CASCADE;`;
