// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentCompletionProvider } from '../app/Providers/AgentCompletionServiceProvider';

export { AgentCompletionRecoveryService, CompletionDeliveryPolicy } from '../app/Services/AgentCompletionRecoveryService';
export type { PendingCompletionSource as PendingCompletionRepository } from '../app/Services/AgentCompletionRecoveryService';

export const recoverPendingAgentCompletions = () => agentCompletionProvider.recovery.recover();
