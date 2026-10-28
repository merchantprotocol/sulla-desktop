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
  add_observational_memory: 'observation',
  search_conversation_logs: 'observation',
  exec: 'meta',
  exechost: 'meta',
  remove_observational_memory: 'observation',
  search_observations: 'observation',
  list_observations: 'observation',
  add_identity_observation: 'observation',
  remove_identity_observation: 'observation',
  search_identity_observations: 'observation',
  list_identity_observations: 'observation',
  update_identity_section: 'observation',
  ask_user_question: 'meta',
  file_search: 'meta',
  read_file: 'meta',
  write_file: 'observation',
  recall_index_lookup: 'memory',
  recall_index_store: 'memory',
  recall_conversations: 'memory',
  browse_tools: 'meta',
};
