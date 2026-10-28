// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The one native tool set every agent gets: primary chat, heartbeat,
 * spawned workers, reviewers, planners and workflow nodes. `exec` reaches
 * the whole `sulla` catalog. Every lane is treated the same, with full access.
 *
 * Kept dependency-free so services and tests can import it without loading
 * the tool registry.
 */
export const FULL_AGENT_TOOL_NAMES: string[] = [
  'browse_tools', 'exec', 'read_file', 'write_file', 'ask_user_question', 'browser_controller',
  'send_job_message', 'report_progress', 'return_result',
];
