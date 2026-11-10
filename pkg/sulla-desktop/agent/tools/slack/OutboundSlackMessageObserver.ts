// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolExecutionContext } from '../executionContext';
export interface OutboundSlackMessage { account: string; teamId: string; channel: string; ts: string; threadTs: string | null; executionContext?: ToolExecutionContext; }
export interface OutboundSlackMessageObserver { onSent(message: OutboundSlackMessage): Promise<void> | void; }
export class NoopOutboundSlackMessageObserver implements OutboundSlackMessageObserver { onSent(_message: OutboundSlackMessage): void {} }
