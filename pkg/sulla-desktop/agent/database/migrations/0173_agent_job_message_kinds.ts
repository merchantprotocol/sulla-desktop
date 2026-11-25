// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Persist server-assigned message trust metadata for delegated inbox entries. */
export const up = `
  ALTER TABLE agent_job_messages
    ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'orchestrator'
      CHECK (message_kind IN ('orchestrator', 'decision', 'decision-fyi'));
`;

export const down = `
  ALTER TABLE agent_job_messages DROP COLUMN message_kind;
`;
