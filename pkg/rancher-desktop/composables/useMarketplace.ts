/**
 * useMarketplace — composable for the Cloudflare marketplace browser.
 *
 * Three reactive actions, all routed through main-process IPC so the
 * renderer never talks to the workers API directly (keeps the JWT out
 * of renderer memory and consolidates the 401-refresh pattern).
 *
 *   load()                 → GET /marketplace/browse
 *   loadDetail(id)         → GET /marketplace/templates/:id (full manifest)
 *   install(id)            → download + unzip into ~/sulla/<kind>s/<slug>/
 *
 * The composable deliberately does not cache. Marketplace content can
 * change between sessions; the browser remounts on tab switch, and that's
 * the right moment to re-fetch.
 */

import { computed, ref } from 'vue';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { MarketplaceKind } from './marketplaceKinds';

export type MarketplaceSort = 'popular' | 'newest' | 'featured';
export type KindFilter = MarketplaceKind | 'all';

export interface MarketplaceDetail {
  row:      MarketplaceBrowseRow;
  manifest: Record<string, unknown>;
}

export interface InstallResult {
  kind:              MarketplaceKind;
  slug:              string;
  path:              string;
  name:              string;
  version?:          string;
  alreadyInstalled?: boolean;
  previousVersion?:  string;
  updated?:          boolean;
  warnings?:         string[];
}

export interface InstalledEntry {
  templateId: string;
  kind:       InstallResult['kind'];
  slug:       string;
  version:    string;
  path:       string;
}

/** 'installed' = on disk at the listed version; 'update' = on disk, older version. */
export type InstallState = 'installed' | 'update' | null;

export function useMarketplace() {
  const templates = ref<MarketplaceBrowseRow[]>([]);
  const total = ref(0);
  const page = ref(1);
  const limit = ref(25);

  const kind = ref<KindFilter>('all');
  const kinds = ref<MarketplaceKind[]>([]);
  const sort = ref<MarketplaceSort>('popular');
  const search = ref('');

  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const detail = ref<MarketplaceDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref<string | null>(null);

  const installing = ref<string | null>(null); // id currently being installed
  const installed = ref<Record<string, InstalledEntry>>({}); // by template id
  const lastInstalled = ref<InstallResult | null>(null);
  const installError = ref<string | null>(null);

  async function load(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const opts: {
        kind?:  MarketplaceKind;
        kinds?: MarketplaceKind[];
        q?:     string;
        sort?:  MarketplaceSort;
        page?:  number;
        limit?: number;
      } = {
        page:  page.value,
        limit: limit.value,
        sort:  sort.value,
      };
      if (kind.value !== 'all') opts.kind = kind.value;
      else if (kinds.value.length > 0) opts.kinds = kinds.value;
      if (search.value.trim()) opts.q = search.value.trim();

      const res = await ipcRenderer.invoke('marketplace-browse', opts);
      if ('error' in res) {
        error.value = res.error;
        templates.value = [];
        total.value = 0;

        return;
      }
      const rows = res.templates ?? [];

      templates.value = rows;
      total.value = res.total ?? rows.length;
      loadInstalled().catch(() => undefined);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      templates.value = [];
      total.value = 0;
    } finally {
      isLoading.value = false;
    }
  }

  async function loadDetail(id: string): Promise<void> {
    detailLoading.value = true;
    detailError.value = null;
    detail.value = null;
    try {
      const res = await ipcRenderer.invoke('marketplace-detail', id);
      if ('error' in res) {
        detailError.value = res.error;

        return;
      }
      const { manifest, ...row } = res.template as any;
      detail.value = {
        row:      row as MarketplaceBrowseRow,
        manifest: (manifest ?? {}) as Record<string, unknown>,
      };
    } catch (err) {
      detailError.value = err instanceof Error ? err.message : String(err);
    } finally {
      detailLoading.value = false;
    }
  }

  function clearDetail(): void {
    detail.value = null;
    detailError.value = null;
  }

  async function loadInstalled(): Promise<void> {
    try {
      const res = await ipcRenderer.invoke('marketplace-installed');
      if ('error' in res) return;
      const map: Record<string, InstalledEntry> = {};
      for (const entry of res.installed ?? []) map[entry.templateId] = entry;
      installed.value = map;
    } catch {
      // Installed badges are a nicety — never block browsing on them.
    }
  }

  /** The local copy of this listing: same template id, else same kind + slug (an older listing). */
  function installedEntryFor(row: { id: string; kind: string; slug: string }): InstalledEntry | null {
    return installed.value[row.id] ??
      Object.values(installed.value).find(e => e.kind === row.kind && e.slug === row.slug) ??
      null;
  }

  function installStateFor(row: { id: string; kind: string; slug: string; version: string }): InstallState {
    const entry = installedEntryFor(row);
    if (!entry) return null;

    return entry.templateId === row.id && entry.version === row.version ? 'installed' : 'update';
  }

  async function install(id: string, opts: { overwrite?: boolean; replaces?: string } = {}): Promise<InstallResult | null> {
    installing.value = id;
    installError.value = null;
    lastInstalled.value = null;
    try {
      const res = await ipcRenderer.invoke('marketplace-install', id, { overwrite: opts.overwrite === true, replaces: opts.replaces });
      if ('error' in res) {
        installError.value = res.error;

        return null;
      }
      lastInstalled.value = res;
      await loadInstalled();

      return res;
    } catch (err) {
      installError.value = err instanceof Error ? err.message : String(err);

      return null;
    } finally {
      installing.value = null;
    }
  }

  async function installAll(id: string, opts: { overwrite?: boolean; replaces?: string } = {}): Promise<InstallResult | null> {
    installing.value = id;
    installError.value = null;
    lastInstalled.value = null;
    try {
      const res = await ipcRenderer.invoke('marketplace-install-all', id, { overwrite: opts.overwrite === true, replaces: opts.replaces });
      if ('error' in res) {
        installError.value = res.error;

        return null;
      }
      lastInstalled.value = res;
      await loadInstalled();

      return res;
    } catch (err) {
      installError.value = err instanceof Error ? err.message : String(err);

      return null;
    } finally {
      installing.value = null;
    }
  }

  async function loadRelated(kind: MarketplaceKind, slug: string): Promise<void> {
    const res = await ipcRenderer.invoke('marketplace-resolve', kind, slug);
    if ('error' in res) {
      detailError.value = res.error;
      return;
    }
    await loadDetail(res.template.id);
  }

  function clearInstallResult(): void {
    lastInstalled.value = null;
    installError.value = null;
  }

  async function setKind(k: KindFilter): Promise<void> {
    kind.value = k;
    page.value = 1;
    await load();
  }

  async function setKinds(next: MarketplaceKind[]): Promise<void> {
    kinds.value = [...new Set(next)];
    kind.value = 'all';
    page.value = 1;
    await load();
  }

  async function setSort(s: MarketplaceSort): Promise<void> {
    sort.value = s;
    page.value = 1;
    await load();
  }

  async function setSearch(q: string): Promise<void> {
    search.value = q;
    page.value = 1;
    await load();
  }

  async function setPage(p: number): Promise<void> {
    page.value = Math.max(1, p);
    await load();
  }

  const isEmpty = computed(() => !isLoading.value && templates.value.length === 0);
  const totalPages = computed(() => (total.value > 0 ? Math.ceil(total.value / limit.value) : 1));

  return {
    // state
    templates,
    total,
    page,
    limit,
    totalPages,
    kind,
    kinds,
    sort,
    search,
    isLoading,
    isEmpty,
    error,

    // detail
    detail,
    detailLoading,
    detailError,
    clearDetail,

    // install
    installing,
    installed,
    installStateFor,
    installedEntryFor,
    loadInstalled,
    lastInstalled,
    installError,
    clearInstallResult,

    // actions
    load,
    loadDetail,
    install,
    installAll,
    loadRelated,
    setKind,
    setKinds,
    setSort,
    setSearch,
    setPage,
  };
}
