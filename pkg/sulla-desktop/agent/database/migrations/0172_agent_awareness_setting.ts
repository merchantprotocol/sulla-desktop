// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentAwarenessDefaults } from '../../services/AgentAwarenessDefaults';

/** Per-agent visibility of live agents, team directories and launch tools. */
export const up = `
  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS agent_awareness BOOLEAN NOT NULL DEFAULT TRUE;
  UPDATE agent_definitions
    SET agent_awareness = FALSE
    WHERE is_builtin = TRUE
      AND slug IN (${ AgentAwarenessDefaults.DEFAULT_OFF_AGENT_SLUG_SQL });
  UPDATE agent_definitions
    SET agent_awareness = TRUE
    WHERE is_builtin = TRUE
      AND slug IN (${ AgentAwarenessDefaults.DEFAULT_ON_AGENT_SLUG_SQL });
`;

export const down = `
  ALTER TABLE agent_definitions DROP COLUMN IF EXISTS agent_awareness;
`;
