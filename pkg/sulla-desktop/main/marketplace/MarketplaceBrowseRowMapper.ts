// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Listing facets the sulla-workers browse API may return on each row.
 * All are optional: a missing key means the API sent nothing, and a
 * null/empty value means "no data". Nothing here invents a value.
 */
export const MARKETPLACE_APPROVAL_MODES = ['drafts_only', 'acts'] as const;
export type MarketplaceApprovalMode = typeof MARKETPLACE_APPROVAL_MODES[number];

export interface MarketplaceListingFacets {
  price_cents?:            number | null;
  currency?:               string | null;
  video_url?:              string | null;
  video_duration_seconds?: number | null;
  poster_url?:             string | null;
  photos?:                 string[];
  requires_apps?:          string[];
  approval_mode?:          MarketplaceApprovalMode | null;
  topic?:                  string | null;
}

export type MarketplaceListingFacetKey = keyof MarketplaceListingFacets;

/**
 * Validates one raw facet value from the API. Stateless; every method takes
 * a value and returns a safe value, so bad input never reaches the renderer.
 */
export class MarketplaceFacetNormalizer {
  /** Trimmed string, or null when absent, non-string or blank. */
  text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();

    return trimmed === '' ? null : trimmed;
  }

  /** Text that must be an absolute http(s) URL (keeps javascript: and relative paths out). */
  url(value: unknown): string | null {
    const trimmed = this.text(value);

    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);

      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
    } catch {
      return null;
    }
  }

  /** Finite number >= 0, or null. */
  nonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  /** Array of trimmed non-empty strings; anything that isn't a clean string array becomes []. */
  stringArray(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return [];

    return value.map(item => item.trim()).filter(item => item !== '');
  }

  /** One of the two known approval modes, or null. */
  approvalMode(value: unknown): MarketplaceApprovalMode | null {
    return (MARKETPLACE_APPROVAL_MODES as readonly unknown[]).includes(value) ? value as MarketplaceApprovalMode : null;
  }
}

/**
 * Normalises the listing facets on a browse row. Other fields pass through
 * untouched. A facet key that is absent from the raw row stays absent.
 * A facet key that is present gets validated: bad scalars become null,
 * bad arrays become [].
 */
export class MarketplaceBrowseRowMapper {
  private readonly normalizer: MarketplaceFacetNormalizer;

  constructor(normalizer: MarketplaceFacetNormalizer = new MarketplaceFacetNormalizer()) {
    this.normalizer = normalizer;
  }

  map<T extends object>(raw: T): Omit<T, MarketplaceListingFacetKey> & MarketplaceListingFacets {
    const source = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    const rules = this.facetRules();

    for (const key of Object.keys(rules) as MarketplaceListingFacetKey[]) {
      if (!(key in source)) continue;
      out[key] = rules[key](source[key]);
    }

    return out as Omit<T, MarketplaceListingFacetKey> & MarketplaceListingFacets;
  }

  private facetRules(): Record<MarketplaceListingFacetKey, (value: unknown) => unknown> {
    const n = this.normalizer;

    return {
      price_cents:            value => n.nonNegativeNumber(value),
      currency:               value => n.text(value),
      video_url:              value => n.url(value),
      video_duration_seconds: value => n.nonNegativeNumber(value),
      poster_url:             value => n.url(value),
      photos:                 value => n.stringArray(value),
      requires_apps:          value => n.stringArray(value),
      approval_mode:          value => n.approvalMode(value),
      topic:                  value => n.text(value),
    };
  }
}
