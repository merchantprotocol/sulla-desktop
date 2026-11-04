// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  agentCompletionProvider,
  COMPLETION_COALESCE_MS,
  COMPLETION_RESULT_LIMIT,
} from '../app/Providers/AgentCompletionServiceProvider';

export { COMPLETION_COALESCE_MS, COMPLETION_RESULT_LIMIT };
export type { PendingCompletion } from '../app/Services/AgentCompletionInboxService';

export const registerCompletionIdleDispatcher = (...args: Parameters<typeof agentCompletionProvider.inbox.registerIdleDispatcher>) =>
  agentCompletionProvider.inbox.registerIdleDispatcher(...args);
export const enqueueAgentCompletion = (...args: Parameters<typeof agentCompletionProvider.inbox.enqueue>) =>
  agentCompletionProvider.inbox.enqueue(...args);
export const setCompletionInboxStopped = (...args: Parameters<typeof agentCompletionProvider.inbox.setStopped>) =>
  agentCompletionProvider.inbox.setStopped(...args);
export const takeAgentCompletions = (...args: Parameters<typeof agentCompletionProvider.inbox.take>) =>
  agentCompletionProvider.inbox.take(...args);
export const formatCompletionBatch = (...args: Parameters<typeof agentCompletionProvider.inbox.format>) =>
  agentCompletionProvider.inbox.format(...args);
export const clearCompletionInboxes = () => agentCompletionProvider.inbox.dispose();
