// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Compatibility builder for callers that still need the default Codex system
 * instructions. CodexService transports the caller-built prompt into the Sulla VM
 * guest per spawn; this module must never write host ~/.codex/AGENTS.md.
 */

export async function generateCodexMemoryFile(): Promise<string> {
  const { buildFullSystemPrompt } = await import('./buildFullSystemPrompt');
  return await buildFullSystemPrompt({ provider: 'openai' });
}
