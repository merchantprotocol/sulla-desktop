// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Keep the original scope on the existing thread row. Never infer it on
// upgrade for rows whose scope was not recorded by the accepting host.
export const up = `
  ALTER TABLE claude_conversations ADD COLUMN IF NOT EXISTS relay_workspace_id TEXT;
  ALTER TABLE claude_conversations ADD COLUMN IF NOT EXISTS relay_host_device_id TEXT;
`;

export const down = '';
