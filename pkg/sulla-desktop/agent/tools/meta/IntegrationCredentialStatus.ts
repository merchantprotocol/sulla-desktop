// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type CredentialState = 'connected' | 'not_connected' | 'unknown';

/** Source of the integration ids that currently have credentials. */
export interface IntegrationIdSource {
  loadEnabledIntegrationIds(): Promise<Set<string>>;
}

/**
 * Production source backed by IntegrationService. The import is lazy because
 * IntegrationService pulls in Postgres, which must stay out of module load.
 */
export class LazyIntegrationIdSource implements IntegrationIdSource {
  async loadEnabledIntegrationIds(): Promise<Set<string>> {
    const { getIntegrationService } = await import('../../services/IntegrationService');
    const enabled = await getIntegrationService().getEnabledIntegrations();
    return new Set(enabled.map(entry => entry.integrationId));
  }
}

interface CredentialSnapshot {
  ids: Set<string>;
  takenAt: number;
}

/**
 * Cached, time-bounded credential lookup. Never waits longer than timeoutMs:
 * a lookup that does not answer in time reports `unknown` and keeps running
 * in the background, so a later call can use its result.
 */
export class IntegrationCredentialStatus {
  private snapshot: CredentialSnapshot | null = null;
  private inFlight: Promise<Set<string>> | null = null;

  constructor(
    private readonly source: IntegrationIdSource,
    private readonly ttlMs = 60_000,
    private readonly timeoutMs = 3_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Connected integration ids, or null when unknown within the timeout. */
  async connectedIntegrations(): Promise<Set<string> | null> {
    if (this.snapshot && this.now() - this.snapshot.takenAt < this.ttlMs) {
      return this.snapshot.ids;
    }
    return this.withTimeout(this.refresh());
  }

  async stateFor(integrationId: string): Promise<CredentialState> {
    const ids = await this.connectedIntegrations();
    if (ids === null) return 'unknown';
    return ids.has(integrationId) ? 'connected' : 'not_connected';
  }

  private refresh(): Promise<Set<string>> {
    if (!this.inFlight) {
      this.inFlight = this.source.loadEnabledIntegrationIds()
        .then((ids) => {
          this.snapshot = { ids, takenAt: this.now() };
          return ids;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async withTimeout(pending: Promise<Set<string>>): Promise<Set<string> | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    try {
      return await Promise.race([pending.then(ids => ids, () => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
