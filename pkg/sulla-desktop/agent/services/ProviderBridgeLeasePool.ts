// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ProviderName } from '../languagemodels/ProviderExecutionTransport';
import type { ProviderCliBridgeLease } from '../../vault-broker';

export interface ProviderBridgeLeasePoolOptions {
  /** Provider and model the container job itself was launched with. */
  runProvider: string;
  runModel?:   string | null;
  /** Maps a CLI launch model to the model id that keys its lease (undefined = CLI default). */
  pinFor(provider: ProviderName, model: string | null | undefined): string | undefined;
  /** Mints one bridge lease for `pinnedModel` (or the CLI default). */
  create(provider: ProviderName, pinnedModel: string | undefined): Promise<ProviderCliBridgeLease>;
}

/**
 * One bridge lease per provider and CLI launch model per container lifecycle,
 * reused across turns.
 */
export class ProviderBridgeLeasePool {
  private readonly leases = new Map<string, Promise<ProviderCliBridgeLease>>();

  constructor(private readonly options: ProviderBridgeLeasePoolOptions) {}

  /** `launchModel` is the model passed to the CLI; omit it to use the job's own model. */
  lease(provider: ProviderName, launchModel?: string): Promise<ProviderCliBridgeLease> {
    const pinnedModel = this.pinnedModelFor(provider, launchModel);
    const key = `${ provider }\u0000${ pinnedModel ?? '' }`;
    const existing = this.leases.get(key);
    if (existing) return existing;
    const created = this.options.create(provider, pinnedModel);
    this.leases.set(key, created);
    created.catch(() => {
      if (this.leases.get(key) === created) this.leases.delete(key);
    });
    return created;
  }

  /** Every lease minted so far (settled or pending), for lifecycle teardown. */
  all(): Promise<ProviderCliBridgeLease>[] {
    return [...this.leases.values()];
  }

  private pinnedModelFor(provider: ProviderName, launchModel: string | undefined): string | undefined {
    if (launchModel !== undefined) return this.options.pinFor(provider, launchModel);
    return provider === this.options.runProvider ? this.options.pinFor(provider, this.options.runModel) : undefined;
  }
}
