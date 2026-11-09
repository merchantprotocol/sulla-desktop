// SPDX-License-Identifier: GPL-2.0-or-later
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

export interface MarketplaceBrowsePage {
  templates: MarketplaceBrowseRow[];
  total: number;
}

export interface MarketplaceListingSource {
  browse(options: { page: number; limit: number }): Promise<MarketplaceBrowsePage | { error: string }>;
  detail(id: string): Promise<{ template: MarketplaceBrowseRow & { manifest?: Record<string, unknown> } } | { error: string }>;
}

/** Loads a complete browse catalog and optional type metadata through the existing IPC boundary. */
export class MarketplaceListingRepository {
  static readonly PAGE_SIZE = 100;
  static readonly DETAIL_CAP = 40;
  static readonly DETAIL_CONCURRENCY = 4;

  constructor(private readonly source: MarketplaceListingSource) {}

  async loadCatalog(): Promise<MarketplaceBrowseRow[]> {
    const first = await this.source.browse({ page: 1, limit: MarketplaceListingRepository.PAGE_SIZE });
    if ('error' in first) throw new Error(first.error);
    const rows = [...first.templates];
    const pages = Math.ceil(first.total / MarketplaceListingRepository.PAGE_SIZE);
    for (let page = 2; page <= pages; page += 1) {
      const result = await this.source.browse({ page, limit: MarketplaceListingRepository.PAGE_SIZE });
      if ('error' in result) throw new Error(result.error);
      rows.push(...result.templates);
    }
    return rows;
  }

  async loadKinds(rows: readonly MarketplaceBrowseRow[]): Promise<Map<string, string[]>> {
    if (rows.length > MarketplaceListingRepository.DETAIL_CAP) return new Map();
    const output = new Map<string, string[]>();
    for (let offset = 0; offset < rows.length; offset += MarketplaceListingRepository.DETAIL_CONCURRENCY) {
      const batch = rows.slice(offset, offset + MarketplaceListingRepository.DETAIL_CONCURRENCY);
      const details = await Promise.all(batch.map(row => this.source.detail(row.id)));
      for (let index = 0; index < details.length; index += 1) {
        const detail = details[index];
        if ('error' in detail) return new Map();
        const contents = detail.template.manifest?.contents;
        if (!Array.isArray(contents)) continue;
        const kinds = contents.flatMap(item => item && typeof item === 'object' && 'kind' in item && typeof item.kind === 'string' ? [item.kind] : []);
        if (kinds.length) output.set(batch[index].id, [...new Set(kinds)]);
      }
    }
    return output;
  }
}
