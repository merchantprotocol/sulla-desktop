/**
 * MarketplaceClient — the agent's view of the Sulla Marketplace.
 *
 * A thin adapter over the same code the Marketplace tab uses:
 *   - HTTP:    main/marketplace/client.ts   (Sulla Cloud workers API)
 *   - install: main/marketplace/install.ts  (safe unzip, install marker, updates)
 *   - publish: main/marketplace/publish.ts  (manifest + zip + two-step submit)
 *
 * The agent addresses artifacts as <kind>/<slug>; the API is keyed by
 * template id, so every call resolves (kind, slug) → the newest approved
 * listing first. Browse/info/download work signed-out; publish, unpublish
 * and list_published need a Sulla Cloud session (sign in from the app).
 */

import { ArtifactKind, fromMarketplaceKind, MarketplaceKind, toMarketplaceKind } from './types';

export interface MarketplaceListing {
  id:             string;
  kind:           ArtifactKind;
  slug:           string;
  name:           string;
  version:        string;
  description?:   string | null;
  tagline?:       string | null;
  category?:      string | null;
  tags:           string[];
  author?:        string | null;
  downloads:      number;
  bundleSize?:    number | null;
  updatedAt?:     string;
  /** Local install of this listing (or an older listing with the same slug), if any. */
  installed?:     { version: string; path: string; templateId: string } | null;
}

export interface SearchOptions {
  query?:    string;
  kind?:     ArtifactKind;
  category?: string;
  limit?:    number;
}

export const SIGN_IN_HINT = 'Sign in to Sulla Cloud in Sulla Desktop (Marketplace tab or My Profile), then retry.';

function requireMarketplaceKind(kind: ArtifactKind): MarketplaceKind {
  const mk = toMarketplaceKind(kind);
  if (!mk) throw new Error(`"${ kind }" artifacts aren't distributed through the marketplace.`);

  return mk;
}

async function api() {
  return await import('@pkg/main/marketplace/client');
}

async function installer() {
  return await import('@pkg/main/marketplace/install');
}

export class MarketplaceClient {
  private toListing(row: any, installed: Awaited<ReturnType<typeof listInstalledSafe>>): MarketplaceListing {
    const local = installed.find(a => a.templateId === row.id) ??
      installed.find(a => a.kind === row.kind && a.slug === row.slug) ?? null;

    return {
      id:          row.id,
      kind:        fromMarketplaceKind(row.kind),
      slug:        row.slug,
      name:        row.name,
      version:     row.version,
      description: row.description ?? null,
      tagline:     row.tagline ?? null,
      category:    row.category ?? null,
      tags:        Array.isArray(row.tags) ? row.tags : [],
      author:      row.author_display ?? null,
      downloads:   Number(row.download_count ?? 0),
      bundleSize:  row.bundle_size ?? null,
      updatedAt:   row.updated_at,
      installed:   local ? { version: local.version, path: local.path, templateId: local.templateId } : null,
    };
  }

  async search(opts: SearchOptions): Promise<{ listings: MarketplaceListing[]; total: number }> {
    const { browseTemplates } = await api();
    const page = await browseTemplates({
      kind:     opts.kind ? requireMarketplaceKind(opts.kind) : undefined,
      q:        opts.query?.trim() || undefined,
      category: opts.category?.trim() || undefined,
      limit:    Math.min(Math.max(opts.limit ?? 25, 1), 100),
    });
    const installed = await listInstalledSafe();

    return { listings: page.templates.map(t => this.toListing(t, installed)), total: page.total };
  }

  /** Newest approved listing for (kind, slug), or null. */
  async resolve(kind: ArtifactKind, slug: string): Promise<MarketplaceListing | null> {
    const { findTemplateBySlug } = await api();
    const row = await findTemplateBySlug(requireMarketplaceKind(kind), slug);
    if (!row) return null;

    return this.toListing(row, await listInstalledSafe());
  }

  async info(kind: ArtifactKind, slug: string): Promise<{ listing: MarketplaceListing; manifest: Record<string, unknown> }> {
    const listing = await this.resolve(kind, slug);
    if (!listing) throw new Error(notFound(kind, slug));
    const { fetchPublicTemplate } = await api();
    const detail = await fetchPublicTemplate(listing.id);

    return { listing, manifest: detail.manifest ?? {} };
  }

  async install(kind: ArtifactKind, slug: string, opts: { overwrite?: boolean } = {}) {
    const listing = await this.resolve(kind, slug);
    if (!listing) throw new Error(notFound(kind, slug));
    const { installTemplate } = await installer();

    return {
      listing,
      result: await installTemplate(listing.id, {
        overwrite: opts.overwrite === true,
        replaces:  listing.installed && listing.installed.templateId !== listing.id ? listing.installed.templateId : undefined,
      }),
    };
  }

  /** Download + safely extract the latest listing into a temp dir. Caller must call `cleanup()`. */
  async fetchLatest(kind: ArtifactKind, slug: string) {
    const listing = await this.resolve(kind, slug);
    if (!listing) throw new Error(notFound(kind, slug));
    const { fetchAndExtract } = await installer();
    const extracted = await fetchAndExtract(listing.id);
    const fs = await import('fs');

    return {
      listing,
      rootPath: extracted.rootPath,
      cleanup:  () => fs.rmSync(extracted.tmpdir, { recursive: true, force: true }),
    };
  }

  async publish(kind: ArtifactKind, sourceDir: string | undefined, slug: string, version?: string) {
    const { publishLocalArtifact } = await import('@pkg/main/marketplace/publish');

    return await publishLocalArtifact({
      kind:      requireMarketplaceKind(kind),
      sourceDir,
      slug,
      overrides: version ? { version } : undefined,
    });
  }

  /** Every submission the signed-in user authored (all statuses). */
  async mySubmissions() {
    const { listMySubmissions } = await api();
    const rows: Awaited<ReturnType<typeof listMySubmissions>>['templates'] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await listMySubmissions(page, 100);
      rows.push(...res.templates);
      if (rows.length >= res.total || res.templates.length === 0) break;
    }

    return rows;
  }

  async takedown(templateId: string) {
    const { takedownTemplate } = await api();

    return await takedownTemplate(templateId);
  }
}

async function listInstalledSafe() {
  try {
    return await (await installer()).listInstalledIncludingAgents();
  } catch {
    return [];
  }
}

function notFound(kind: ArtifactKind, slug: string): string {
  return `No approved marketplace listing for ${ kind }/${ slug }. Try \`sulla marketplace/search '{"query":"${ slug }"}'\`.`;
}

/** True when an error means "not signed in to Sulla Cloud". */
export function isAuthError(err: unknown): boolean {
  return /Not signed in to Sulla Cloud|\b401\b|\b403\b|Invalid or expired access token/i.test(String((err as Error)?.message ?? err));
}

let singleton: MarketplaceClient | null = null;

export function getMarketplaceClient(): MarketplaceClient {
  if (!singleton) singleton = new MarketplaceClient();

  return singleton;
}
