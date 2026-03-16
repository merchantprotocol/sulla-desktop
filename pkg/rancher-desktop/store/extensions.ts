import semver from 'semver';
import { GetterTree, MutationTree } from 'vuex';
import yaml from 'yaml';

import { fetchAPI } from './credentials';
import { ActionTree, MutationsType } from './ts-helpers';

import type { ExtensionMetadata } from '@pkg/main/extensions/types';

const MARKETPLACE_URL = 'https://raw.githubusercontent.com/merchantprotocol/sulla-recipes/refs/heads/main/index.yaml';
const CACHE_TTL_MS = 30 * 60 * 1000;

let cachedMarketplaceData: MarketplaceData[] | undefined;
let cacheExpiresAt = 0;
let inFlightMarketplaceFetch: Promise<MarketplaceData[]> | undefined;

/**
 * BackendExtensionState describes the API response from the API backend.
 * The raw response is a record of slug (i.e. extension ID without version) to
 * this structure.
 */
interface BackendExtensionState {
  /** The installed extension version. */
  version:  string;
  /** Information from the extension's metadata.json. */
  metadata: ExtensionMetadata;
  /** Labels on the extension image. */
  labels:   Record<string, string>;
}

/**
 * ExtensionState describes the data this Vuex store exposes; this is the same
 * as the backend state with the addition of a version available in the catalog.
 */
export type ExtensionState = BackendExtensionState & {
  /** The extension id, excluding the version (tag). Also known as "slug". */
  id:                string;
  /** The version available in the marketplace. */
  availableVersion?: string;
  /** Whether this extension can be upgraded (i.e. availableVersion > version). */
  canUpgrade:        boolean;
};

interface ExtensionsState {
  extensions:      Record<string, ExtensionState>;
  marketplaceData: MarketplaceData[];
}

export interface MarketplaceData {
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

async function fetchMarketplaceData(): Promise<MarketplaceData[]> {
  if (cachedMarketplaceData && Date.now() < cacheExpiresAt) {
    return cachedMarketplaceData;
  }

  if (inFlightMarketplaceFetch) {
    return inFlightMarketplaceFetch;
  }

  inFlightMarketplaceFetch = (async() => {
    try {
      const response = await fetch(MARKETPLACE_URL);

      if (!response.ok) {
        console.error(`Failed to fetch marketplace data: ${ response.status }`);

        return cachedMarketplaceData ?? [];
      }

      const text = await response.text();
      const parsed = yaml.parse(text) as { plugins?: MarketplaceData[] };

      cachedMarketplaceData = parsed.plugins ?? [];
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;

      return cachedMarketplaceData;
    } catch (ex) {
      console.error(`Error fetching marketplace data: ${ ex }`);

      return cachedMarketplaceData ?? [];
    } finally {
      inFlightMarketplaceFetch = undefined;
    }
  })();

  return inFlightMarketplaceFetch;
}

export const state: () => ExtensionsState = () => ({ extensions: {}, marketplaceData: [] });

export const mutations = {
  SET_EXTENSIONS(state, extensions: Record<string, ExtensionState>) {
    state.extensions = extensions;
  },
  SET_MARKETPLACE_DATA(state, data: MarketplaceData[]) {
    state.marketplaceData = data;
  },
} satisfies Partial<MutationsType<ExtensionsState>> & MutationTree<ExtensionsState>;

export const actions = {
  async fetch({ commit, rootState }) {
    const [response, marketplaceData] = await Promise.all([
      fetchAPI('/v1/extensions', rootState),
      fetchMarketplaceData(),
    ]);

    commit('SET_MARKETPLACE_DATA', marketplaceData);

    if (!response.ok) {
      console.log(`fetchExtensions: failed: status: ${ response.status }:${ response.statusText }`);

      return;
    }
    const backendState: Record<string, BackendExtensionState> = await response.json();
    const result = Object.fromEntries(Object.entries(backendState).map(([id, data]) => {
      const marketplaceEntry = marketplaceData.find(ext => ext.slug === id);
      const frontendState: ExtensionState = {
        ...data, id, canUpgrade: false,
      };

      if (marketplaceEntry) {
        frontendState.availableVersion = marketplaceEntry.version;
        try {
          frontendState.canUpgrade = semver.gt(marketplaceEntry.version, data.version);
        } catch {
          // Either existing version or catalog version is invalid; can't upgrade.
        }
      }

      return [id, frontendState];
    }));

    commit('SET_EXTENSIONS', result);
  },

  /**
   * Install an extension by id.
   * @param id The extension id; this should include the tag.
   * @returns Error message, or `true` if extension is installed.
   */
  async install({ rootState, dispatch }, { id }: { id: string }) {
    const r = await fetchAPI(`/v1/extensions/install?id=${ id }`, rootState, { method: 'POST' });

    await dispatch('fetch');

    if (!r.ok) {
      return r.statusText;
    }

    return r.status === 201;
  },

  /**
   * Uninstall an extension by id.
   * @param id The extension id; this should _not_ include the tag.
   * @returns Error message, or `true` if extension is uninstall.
   */
  async uninstall({ rootState, dispatch }, { id }: { id: string }) {
    const r = await fetchAPI(`/v1/extensions/uninstall?id=${ id }`, rootState, { method: 'POST' });

    await dispatch('fetch');

    if (!r.ok) {
      return r.statusText;
    }

    return r.status === 201;
  },
} satisfies ActionTree<ExtensionsState, any, typeof mutations, typeof getters>;

export const getters = {
  installedExtensions(state): ExtensionState[] {
    return Object.values(state.extensions);
  },
  marketData(state): MarketplaceData[] {
    return state.marketplaceData;
  },
} satisfies GetterTree<ExtensionsState, any>;
