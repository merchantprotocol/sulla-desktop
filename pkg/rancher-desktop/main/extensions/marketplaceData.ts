import yaml from 'yaml';

import Logging from '@pkg/utils/logging';

const console = Logging.extensions;

const MARKETPLACE_URL = 'https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/index.yaml';
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface MarketplaceEntry {
  slug:                  string;
  version:               string;
  containerd_compatible: boolean;
  labels:                Record<string, string>;
  title:                 string;
  logo:                  string;
  publisher:             string;
  short_description:     string;
  installable?:          string;
}

interface RemoteIndex {
  version:      string;
  generated_at: string;
  plugins:      MarketplaceEntry[];
}

let cachedData: MarketplaceEntry[] | undefined;
let cacheExpiresAt = 0;
let inFlightFetch: Promise<MarketplaceEntry[]> | undefined;

/**
 * Fetch the marketplace extension data from the remote index.yaml.
 * Results are cached after the first successful fetch.
 */
export async function fetchMarketplaceData(): Promise<MarketplaceEntry[]> {
  if (cachedData && Date.now() < cacheExpiresAt) {
    return cachedData;
  }

  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async() => {
    try {
      const response = await fetch(MARKETPLACE_URL);

      if (!response.ok) {
        console.error(`Failed to fetch marketplace data: ${ response.status } ${ response.statusText }`);

        return cachedData ?? [];
      }

      const text = await response.text();
      const parsed = yaml.parse(text) as Partial<RemoteIndex>;

      cachedData = parsed.plugins ?? [];
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      console.log(`Fetched ${ cachedData.length } extensions from remote marketplace`);

      return cachedData;
    } catch (ex) {
      console.error(`Error fetching marketplace data: ${ ex }`);

      return cachedData ?? [];
    } finally {
      inFlightFetch = undefined;
    }
  })();

  return inFlightFetch;
}

/**
 * Invalidate the cached marketplace data so the next call re-fetches.
 */
export function invalidateMarketplaceCache(): void {
  cachedData = undefined;
  cacheExpiresAt = 0;
  inFlightFetch = undefined;
}
