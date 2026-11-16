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
  /** Maps a CLI launch model to the exact model id its bridge may serve (undefined = unpinned). */
  pinFor(provider: ProviderName, model: string | null | undefined): string | undefined;
  /** Mints one bridge lease pinned to `pinnedModel` (or unpinned). */
  create(provider: ProviderName, pinnedModel: string | undefined): Promise<ProviderCliBridgeLease>;
}

/**
 * One bridge lease per provider and pinned model for a container lifecycle.
 *
 * A bridge is pinned to the model its CLI process is launched with. Other
 * graphs inside the same lifecycle (subconscious observers on the light
 * model, for example) launch their CLI with a different model, so they get
 * their own pinned lease instead of reusing the job's lease and having every
 * request denied with `provider_model_denied`.
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
