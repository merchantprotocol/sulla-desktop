// SPDX-License-Identifier: GPL-2.0-or-later
export interface DecisionAnswerDeliveryInput { id: string; attempt: string; body: string; }
/** Public messages cannot carry receipt authority; only a privately passed mailbox claim can. */
export class DecisionAnswerDelivery {
  static publicMetadata(value?: Record<string, unknown>): Record<string, unknown> {
    const { decisionAnswerInputs: _inputs, decisionAnswerIds: _ids, ...metadata } = value ?? {};
    return metadata;
  }
}
