/**
 * Marketplace IPC handlers.
 *
 * Thin IPC layer over the Sulla Cloud marketplace API
 * (`main/marketplace/client.ts`) and the shared install pipeline
 * (`main/marketplace/install.ts`, also used by the agent's
 * `marketplace/*` tools):
 *
 *   marketplace-browse         → GET    /marketplace/browse
 *   marketplace-detail         → GET    /marketplace/templates/:id
 *   marketplace-install        → download + safe-unzip + install (or update in place)
 *   marketplace-installed      → what's installed locally from the marketplace
 *   marketplace-my-submissions → GET    /marketplace/mine
 *   marketplace-takedown       → DELETE /marketplace/templates/:id
 *
 * Reads are public on the server; the JWT is attached when the user is
 * signed in but not required. Whether the Marketplace tab asks users to
 * sign in first is a UI decision, not enforced here.
 */
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

const errorOf = (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) });

export function initSullaMarketplaceEvents(): void {
  // ── Browse approved templates ──
  ipcMainProxy.handle('marketplace-browse', async(_event, opts = {}) => {
    try {
      const { browseTemplates } = await import('@pkg/main/marketplace/client');

      return await browseTemplates(opts) as any;
    } catch (err) {
      console.error('[Sulla] marketplace-browse failed:', err);

      return errorOf(err);
    }
  });

  // ── Template detail + full manifest ──
  ipcMainProxy.handle('marketplace-detail', async(_event, id: string) => {
    if (!id || typeof id !== 'string') {
      return { error: 'marketplace-detail requires a template id' };
    }
    try {
      const { fetchPublicTemplate } = await import('@pkg/main/marketplace/client');

      return { template: await fetchPublicTemplate(id) } as any;
    } catch (err) {
      console.error('[Sulla] marketplace-detail failed:', err);

      return errorOf(err);
    }
  });

  // ── Install (or update in place with { overwrite: true }) ──
  ipcMainProxy.handle('marketplace-install', async(_event, id: string, opts?: { overwrite?: boolean; replaces?: string }) => {
    if (!id || typeof id !== 'string') {
      return { error: 'marketplace-install requires a template id' };
    }
    try {
      const { installTemplate } = await import('@pkg/main/marketplace/install');

      return await installTemplate(id, {
        overwrite: opts?.overwrite === true,
        replaces:  typeof opts?.replaces === 'string' ? opts.replaces : undefined,
      });
    } catch (err) {
      console.error('[Sulla] marketplace-install failed:', err);

      return errorOf(err);
    }
  });

  // ── Locally installed marketplace artifacts ──
  ipcMainProxy.handle('marketplace-installed', async() => {
    try {
      const { listInstalled } = await import('@pkg/main/marketplace/install');

      return {
        installed: listInstalled().map(a => ({
          templateId: a.templateId,
          kind:       a.kind,
          slug:       a.slug,
          version:    a.version,
          path:       a.path,
        })),
      };
    } catch (err) {
      console.error('[Sulla] marketplace-installed failed:', err);

      return errorOf(err);
    }
  });

  // ── List the signed-in user's own submissions ──
  // Every status (pending, approved, rejected) so "My Submissions" can show
  // the full history with reviewer notes.
  ipcMainProxy.handle('marketplace-my-submissions', async(_event, opts: { page?: number; limit?: number } = {}) => {
    try {
      const { listMySubmissions } = await import('@pkg/main/marketplace/client');
      const page = typeof opts.page === 'number' && opts.page > 0 ? opts.page : 1;
      const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 50;

      return await listMySubmissions(page, limit) as any;
    } catch (err) {
      console.error('[Sulla] marketplace-my-submissions failed:', err);

      return errorOf(err);
    }
  });

  // ── User-initiated takedown of their own submission ──
  // Server enforces caller == author. `action` is 'deleted' (pending or
  // already-rejected) or 'withdrawn' (approved → rejected, kept in /mine).
  ipcMainProxy.handle('marketplace-takedown', async(_event, id: string) => {
    if (!id || typeof id !== 'string') {
      return { error: 'marketplace-takedown requires a template id' };
    }
    try {
      const { takedownTemplate } = await import('@pkg/main/marketplace/client');

      return await takedownTemplate(id) as any;
    } catch (err) {
      console.error('[Sulla] marketplace-takedown failed:', err);

      return errorOf(err);
    }
  });

  console.log('[Sulla] Marketplace IPC handlers initialized');
}
