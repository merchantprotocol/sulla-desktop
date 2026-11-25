// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';

interface DecisionSource {
  subscribe(listener: (record: DecisionRecord) => void): () => void;
}

interface FilesPublishClient {
  request(path: string, options: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number }>;
}

/** Applies a human's durable publish decision to Files exactly once per running Desktop session. */
export class FilesPublishDecisionApplier {
  private readonly handled = new Set<string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly decisions: DecisionSource,
    private readonly client: () => Promise<FilesPublishClient>,
    private readonly reportFailure: (message: string, error?: unknown) => void,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.decisions.subscribe(record => { void this.apply(record) });
  }

  private async apply(record: DecisionRecord): Promise<void> {
    const requestId = record.payload?.filesPublishRequestId;
    if (!requestId || record.kind !== 'approval' || !['approved', 'denied', 'expired'].includes(record.status) ||
        (record.answeredBy && record.answeredBy.kind !== 'human') || this.handled.has(record.id)) return;
    this.handled.add(record.id);
    const action = record.status === 'approved' ? 'approve' : 'reject';
    try {
      const response = await (await this.client()).request(`/v1/files/publish-requests/${ encodeURIComponent(requestId) }/${ action }`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!response.ok && response.status !== 409) this.reportFailure(`Files publish request ${ requestId } ${ action } failed: HTTP ${ response.status }`);
    } catch (error) {
      this.reportFailure(`Files publish request ${ requestId } ${ action } failed:`, error);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.handled.clear();
  }
}
