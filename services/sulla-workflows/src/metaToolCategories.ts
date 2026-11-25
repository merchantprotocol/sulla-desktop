// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Category for each meta tool, used to build a runner's tool scope.
 * Mirrors pkg/sulla-desktop/agent/tools/meta/manifests.ts without importing its tool loaders;
 * scripts/contracts/server-split-contract.test.mjs fails if the two drift.
 */
export const META_TOOL_CATEGORIES: Readonly<Record<string, string>> = {
  upsert_conversation_keywords: 'observation',
  search_conversation_keywords: 'observation',
  search_conversation_logs: 'observation',
  exec: 'meta',
  exechost: 'meta',
  ask_user_question: 'meta',
  file_search: 'meta',
  read_file: 'meta',
  write_file: 'observation',
  recall_index_lookup: 'memory',
  recall_index_store: 'memory',
  recall_conversations: 'memory',
  // The Dreamer core routine's tool-call node (agent/tools/episodic/dream.ts).
  dream_recent_memories: 'memory',
  browse_tools: 'meta',
};
