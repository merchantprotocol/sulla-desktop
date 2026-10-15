/** Database-only marketplace install and publish IPC handlers. */
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import type { MarketplaceKind } from './marketplace/client';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

export function initSullaBundleEvents(): void {
  ipcMainProxy.handle('bundles-install-from-marketplace', async(_event: unknown, templateId: string) => {
    if (!templateId || typeof templateId !== 'string') throw new Error('bundles-install-from-marketplace: templateId is required');
    try {
      const { installTemplate } = await import('./marketplace/install');

      return await installTemplate(templateId);
    } catch (error) {
      console.error(`[marketplace-install] failed tpl=${ templateId }`, error);

      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMainProxy.handle('bundles-publish', async(_event: unknown, args: {
    kind:         MarketplaceKind;
    slug?:        string;
    extensionId?: string;
    overrides?:   { name?: string; description?: string; version?: string; tags?: string[] };
  }) => {
    const { kind, overrides } = args ?? ({} as any);
    if (!kind) throw new Error('bundles-publish: kind is required');
    const slug = kind === 'recipe' ? args.extensionId : args.slug;
    if (!slug) throw new Error(`bundles-publish(${ kind }): slug is required`);
    try {
      const { publishLocalArtifact } = await import('./marketplace/publish');

      return await publishLocalArtifact({ kind, slug, overrides });
    } catch (error) {
      console.error(`[marketplace-publish] failed kind=${ kind } slug=${ slug }`, error);

      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMainProxy.handle('bundles-publish-bulk-from-dir', (_event: unknown, args: { kind?: MarketplaceKind } = {}) => ({
    error: `Folder publishing is disabled. Publish ${ args.kind ?? 'artifacts' } from Postgres by slug.`,
  }));

  console.log('[Sulla] Database bundle IPC handlers initialized');
}
