// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PackageContentItem, PackageRow } from './usePackages';

/**
 * Turns marketplace browse rows / manifests into PackageRow. Fields are read
 * from the row first, then its `summary`, then the manifest.
 */
export class PackageRowMapper {
  static toPackageRow(raw: Record<string, any>, manifestIn?: Record<string, unknown>): PackageRow {
    const str = PackageRowMapper.str;
    const summary = PackageRowMapper.obj(raw.summary);
    const manifest = PackageRowMapper.obj(manifestIn ?? raw.manifest);
    const pick = (key: string) => raw[key] ?? summary[key] ?? manifest[key];
    const app = str(pick('app'));
    const contentSource = Object.keys(manifest).length ? manifest : summary;
    const dashboardPort = PackageRowMapper.recipeWebPort(contentSource);
    const contents = PackageRowMapper.toContents(contentSource);
    const keywords = pick('keywords') ?? raw.tags;

    return {
      id:       str(raw.id),
      slug:     str(raw.slug, manifest.slug),
      name:     str(raw.name, manifest.name, raw.slug),
      title:    str(pick('title'), raw.tagline, raw.name),
      line:     str(pick('line'), raw.description, manifest.description),
      topic:    str(pick('topic'), raw.category),
      icon:     str(pick('icon')) || '📦',
      app:      dashboardPort ? 'dashboard' : app === 'app' ? 'app' : 'none',
      where:    contents.some(item => item.kind === 'recipe') || str(pick('where')) === 'desktop' ? 'desktop' : 'both',
      keywords: Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === 'string') : [],
      version:  str(raw.version, manifest.version),
      publisher: str(raw.author_display, raw.publisher, manifest.publisher) || 'Sulla',
      bundleSize: Number(raw.bundle_size) || 0,
      updatedAt: str(raw.updated_at),
      contents,
      dashboardPort,
    };
  }

  static matches(row: PackageRow, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;

    return [row.title, row.line, row.name, row.slug, ...row.keywords].join(' ').toLowerCase().includes(q);
  }

  static str(...values: unknown[]): string {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }

    return '';
  }

  static obj(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private static recipeWebPort(manifest: Record<string, any>): number | undefined {
    const contents = Array.isArray(manifest.contents) ? manifest.contents : [];
    for (const entry of contents) {
      if (entry?.kind !== 'recipe') continue;
      const recipe = PackageRowMapper.obj(entry.manifest);
      const candidates = [recipe.web?.port, recipe.ui?.port, recipe.dashboard?.port, recipe.port, PackageRowMapper.obj(recipe.spec).web?.port];
      const port = candidates.map(Number).find(value => Number.isInteger(value) && value > 0 && value <= 65535);
      if (port) return port;
    }
    return undefined;
  }

  static toContents(manifest: Record<string, any>): PackageContentItem[] {
    const str = PackageRowMapper.str;
    const obj = PackageRowMapper.obj;
    const list = Array.isArray(manifest.contents) ? manifest.contents : [];

    return list.map((entry: unknown) => {
      const item = obj(entry);
      const inner = obj(item.manifest);
      const innerMeta = obj(inner.metadata);

      return {
        kind:    str(item.kind),
        slug:    str(item.slug, inner.slug),
        name:    str(inner.name, innerMeta.name, item.name, item.slug),
        version: str(item.version, inner.version),
        description: str(inner.description, inner.summary, item.description),
        required: item.required === true || inner.required === true,
        containers: Array.isArray(inner.containers)
          ? inner.containers.map((container: unknown) => typeof container === 'string' ? container : str(obj(container).name, obj(container).service)).filter(Boolean)
          : [],
        dataVolume: str(inner.data_volume, inner.dataVolume, obj(inner.storage).volume),
      };
    }).filter((item: PackageContentItem) => item.kind && item.slug);
  }
}
