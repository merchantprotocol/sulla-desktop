// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Database-only marketplace install and publish IPC handlers. */
import type { IpcController, IpcRegistrar } from './ipc/IpcController';
import type { MarketplaceKind } from './marketplace/client';

type PublishOverrides = { name?: string; description?: string; version?: string; tags?: string[] };

export interface BundleMarketplacePort {
  install(templateId: string): Promise<unknown>;
  publish(input: { kind: MarketplaceKind; slug: string; overrides?: PublishOverrides }): Promise<unknown>;
}

export interface BundleLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Default port: lazy-loads the marketplace install/publish modules on first use. */
export class LazyBundleMarketplace implements BundleMarketplacePort {
  async install(templateId: string): Promise<unknown> {
    const { installTemplate } = await import('./marketplace/install');

    return installTemplate(templateId);
  }

  async publish(input: { kind: MarketplaceKind; slug: string; overrides?: PublishOverrides }): Promise<unknown> {
    const { publishLocalArtifact } = await import('./marketplace/publish');

    return publishLocalArtifact(input as any);
  }
}

/** bundles-* — install from and publish to the marketplace. */
export class SullaBundleIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly marketplace: BundleMarketplacePort, private readonly log: BundleLogger) {}

  register(): void {
    this.ipc.handle('bundles-install-from-marketplace', async(_event: unknown, templateId: string) => {
      if (!templateId || typeof templateId !== 'string') throw new Error('bundles-install-from-marketplace: templateId is required');
      try {
        return await this.marketplace.install(templateId);
      } catch (error) {
        this.log.error(`[marketplace-install] failed tpl=${ templateId }`, error);

        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    this.ipc.handle('bundles-publish', async(_event: unknown, args: {
      kind:         MarketplaceKind;
      slug?:        string;
      extensionId?: string;
      overrides?:   PublishOverrides;
    }) => {
      const { kind, overrides } = args ?? ({} as any);
      if (!kind) throw new Error('bundles-publish: kind is required');
      const slug = kind === 'recipe' ? args.extensionId : args.slug;
      if (!slug) throw new Error(`bundles-publish(${ kind }): slug is required`);
      try {
        return await this.marketplace.publish({ kind, slug, overrides });
      } catch (error) {
        this.log.error(`[marketplace-publish] failed kind=${ kind } slug=${ slug }`, error);

        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    this.ipc.handle('bundles-publish-bulk-from-dir', (_event: unknown, args: { kind?: MarketplaceKind } = {}) => ({
      error: `Folder publishing is disabled. Publish ${ args.kind ?? 'artifacts' } from Postgres by slug.`,
    }));

    this.log.log('[Sulla] Database bundle IPC handlers initialized');
  }
}
