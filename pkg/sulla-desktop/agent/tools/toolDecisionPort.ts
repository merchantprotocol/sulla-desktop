// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionOutcome, DecisionRecord } from '@pkg/shared/decisions';

/** The approval surface a tool call needs. Desktop's DecisionService satisfies it structurally. */
export type ToolDecisionRequest = Omit<DecisionRecord, 'id' | 'status' | 'createdAt' | 'expiresAt'>;

export interface ToolDecisionHandle {
  readonly record: DecisionRecord;
  readonly result: Promise<DecisionOutcome>;
}

export interface ToolDecisionPort {
  requiresApproval(toolName: string): Promise<boolean>;
  request(input: ToolDecisionRequest, timeoutMs?: number, signal?: AbortSignal): Promise<ToolDecisionHandle>;
}

/**
 * The port a runtime without the Desktop approval inbox gets. Every tool counts as approval-gated and
 * every request is refused, so nothing runs unapproved. Desktop main replaces it at startup.
 */
export class UnavailableToolDecisionPort implements ToolDecisionPort {
  async requiresApproval(): Promise<boolean> {
    return true;
  }

  async request(): Promise<ToolDecisionHandle> {
    throw new Error('Approval is unavailable in this runtime. Nothing was executed.');
  }
}

/** Holds the approval port that tool calls use. Desktop main registers the real DecisionService at startup. */
export class ToolDecisionPortRegistry {
  private port: ToolDecisionPort = new UnavailableToolDecisionPort();

  register(port: ToolDecisionPort): void {
    this.port = port;
  }

  resolve(): ToolDecisionPort {
    return this.port;
  }
}

export const toolDecisionPort = new ToolDecisionPortRegistry();
