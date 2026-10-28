// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Settings key for the starter automation chosen in the first-run wizard.
 *
 * FirstRunFirstAutomation writes the user's first request here; the chat
 * composer reads it once when the main window opens, prefills the draft, and
 * clears the key so it never appears again.
 */
export const FIRST_RUN_STARTER_PROMPT_KEY = 'firstRunStarterPrompt';
