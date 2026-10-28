// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Locked core routines always execute with the product's default Sulla Desktop
 * profile. Role-specific behavior belongs in the workflow node's task prompt,
 * never in a custom agent directory that can replace prompts or tool policy.
 */
export const DEFAULT_CORE_ROUTINE_AGENT_ID = 'sulla-desktop' as const;

