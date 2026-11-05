// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentCompletionProvider, COMPLETION_RESULT_LIMIT } from '../app/Providers/AgentCompletionServiceProvider';
import { AgentCompletionInboxService } from '../app/Services/AgentCompletionInboxService';
import { CompletionFormatter } from '../app/Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../app/Services/CompletionIdleDispatcher';

export { COMPLETION_RESULT_LIMIT };
export type { AgentTerminalNotice, PendingCompletion } from '../app/Services/AgentCompletionInboxService';

/** Backwards-compatible constructable inbox with instance-owned state. */
export class CompletionInboxStore extends AgentCompletionInboxService {
  constructor() {
    super(new CompletionIdleDispatcher(), new CompletionFormatter(COMPLETION_RESULT_LIMIT));
  }
}

export { CompletionInboxStore as AgentCompletionInbox };
export const completionInboxStore = agentCompletionProvider.inbox;

export const registerCompletionIdleDispatcher = (...args: Parameters<typeof agentCompletionProvider.inbox.registerIdleDispatcher>) =>
  agentCompletionProvider.inbox.registerIdleDispatcher(...args);
export const enqueueAgentCompletion = (...args: Parameters<typeof agentCompletionProvider.inbox.enqueue>) =>
  agentCompletionProvider.inbox.enqueue(...args);
export const notifyAgentCompletionsReady = (...args: Parameters<typeof agentCompletionProvider.inbox.notifyReady>) =>
  agentCompletionProvider.inbox.notifyReady(...args);
export const setCompletionInboxStopped = (...args: Parameters<typeof agentCompletionProvider.inbox.setStopped>) =>
  agentCompletionProvider.inbox.setStopped(...args);
export const takeAgentCompletions = (...args: Parameters<typeof agentCompletionProvider.inbox.take>) =>
  agentCompletionProvider.inbox.take(...args);
export const formatCompletionBatch = (...args: Parameters<typeof agentCompletionProvider.inbox.format>) =>
  agentCompletionProvider.inbox.format(...args);
export const clearCompletionInboxes = () => agentCompletionProvider.inbox.dispose();
