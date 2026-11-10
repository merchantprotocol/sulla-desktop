// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import type { ToolExecutionContext } from '../../tools/executionContext';
export interface SlackApiTransportRequest { accountId: string; method: string; body: Record<string, unknown>; executionContext?: ToolExecutionContext; }
export interface SlackApiTransportResponse { status: number; body: Record<string, any>; }
export interface SlackApiTransport { call(input: SlackApiTransportRequest): Promise<SlackApiTransportResponse>; }
