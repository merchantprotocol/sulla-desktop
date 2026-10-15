/**
 * usePackages — controller for the Packages screen (formerly the
 * Marketplace tab). A package is one use case in one download: it bundles
 * the agents, skills, routines, functions, integrations and recipes it
 * needs.
 *
 *   load()            → marketplace-browse { kind: 'package' }
 *   loadDetail(id)    → marketplace-detail (manifest carries description_md + contents)
 *   loadInstalled()   → packages:list-installed
 *   install(id)       → packages:install { templateId }  (all-or-nothing)
 *   uninstall(slug)   → packages:uninstall { slug }
 *
 * Package fields (title, line, topic, icon, app, ...) are read from the
 * browse row first, then its `summary`, then the manifest, so the screen
 * keeps working whichever level the API ends up putting them on.
 */

import { computed, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type PackageApp = 'none' | 'dashboard' | 'app';

export interface PackageRow {
  id:       string;
  slug:     string;
  name:     string;
  title:    string;
  line:     string;
  topic:    string;
  icon:     string;
  app:      PackageApp;
  where:    'both' | 'desktop';
  keywords: string[];
  version:  string;
}

export interface PackageContentItem {
  kind:    string;
  slug:    string;
  name:    string;
  version: string;
}

export interface PackageDetail {
  row:           PackageRow;
  descriptionMd: string;
  contents:      PackageContentItem[];
  /** Kind of the template that was opened — non-packages arrive via old deep links. */
  templateKind:  string;
  raw:           Record<string, unknown>;
  manifest:      Record<string, unknown>;
}

export interface InstalledPackage {
  slug:        string;
  version:     string;
  name:        string;
  title:       string;
  icon:        string;
  installedAt: string;
  items:       { kind: string; slug: string }[];
}

export interface PackageInstallResult {
  ok:         boolean;
  package?:   { slug: string; version: string };
  installed?: { kind: string; slug: string }[];
  error?:     string;
}

export interface PackageUninstallResult {
  ok:       boolean;
  removed?: { kind: string; slug: string }[];
  error?:   string;
}

// ── IPC call boundary ────────────────────────────────────────────────
// `packages:*` handlers are built by the package-installer task (main
// process). STUB BOUNDARY: until those handlers are registered, Electron
// rejects with "No handler registered", which we turn into an honest
// "not available yet" answer. Remove the fallback once the installer
// lands; nothing else in the screen needs to change.
const invoke = ipcRenderer.invoke as unknown as (channel: string, ...args: unknown[]) => Promise<any>;

function isMissingHandler(err: unknown): boolean {
  return /no handler registered/i.test(err instanceof Error ? err.message : String(err));
}

const NOT_AVAILABLE = 'Installing use cases needs a newer Sulla Desktop. Update and try again.';

export const packagesIpc = {
  async install(templateId: string): Promise<PackageInstallResult> {
    try {
      return await invoke('packages:install', { templateId });
    } catch (err) {
      if (isMissingHandler(err)) return { ok: false, error: NOT_AVAILABLE }; // STUB BOUNDARY

      throw err;
    }
  },
  async uninstall(slug: string): Promise<PackageUninstallResult> {
    try {
      return await invoke('packages:uninstall', { slug });
    } catch (err) {
      if (isMissingHandler(err)) return { ok: false, error: NOT_AVAILABLE }; // STUB BOUNDARY

      throw err;
    }
  },
  async listInstalled(): Promise<InstalledPackage[]> {
    try {
      const res = await invoke('packages:list-installed');

      return Array.isArray(res) ? res : [];
    } catch (err) {
      if (isMissingHandler(err)) return []; // STUB BOUNDARY

      throw err;
    }
  },
};

// ── Row normalization ────────────────────────────────────────────────

function str(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  return '';
}

function obj(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function toPackageRow(raw: Record<string, any>, manifestIn?: Record<string, unknown>): PackageRow {
  const summary = obj(raw.summary);
  const manifest = obj(manifestIn ?? raw.manifest);
  const pick = (key: string) => raw[key] ?? summary[key] ?? manifest[key];
  const app = str(pick('app'));
  const keywords = pick('keywords') ?? raw.tags;

  return {
    id:       str(raw.id),
    slug:     str(raw.slug, manifest.slug),
    name:     str(raw.name, manifest.name, raw.slug),
    title:    str(pick('title'), raw.tagline, raw.name),
    line:     str(pick('line'), raw.description, manifest.description),
    topic:    str(pick('topic'), raw.category),
    icon:     str(pick('icon')) || '📦',
    app:      app === 'dashboard' || app === 'app' ? app : 'none',
    where:    str(pick('where')) === 'desktop' ? 'desktop' : 'both',
    keywords: Array.isArray(keywords) ? keywords.filter((k): k is string => typeof k === 'string') : [],
    version:  str(raw.version, manifest.version),
  };
}

function toContents(manifest: Record<string, any>): PackageContentItem[] {
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
    };
  }).filter((item: PackageContentItem) => item.kind && item.slug);
}

export function packageMatches(row: PackageRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  return [row.title, row.line, row.name, row.slug, ...row.keywords].join(' ').toLowerCase().includes(q);
}

// ── Composable ───────────────────────────────────────────────────────

export function usePackages() {
  const packages = ref<PackageRow[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const detail = ref<PackageDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref<string | null>(null);

  const installed = ref<InstalledPackage[]>([]);
  const busySlug = ref<string | null>(null); // package currently installing / uninstalling

  const installedSlugs = computed(() => new Set(installed.value.map(p => p.slug)));

  async function load(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const res = await invoke('marketplace-browse', { kind: 'package', sort: 'popular', limit: 100 });
      if (res && 'error' in res) {
        // Until the marketplace API knows the `package` kind it rejects
        // the filter outright. That simply means nothing is published yet.
        if (/unknown kind/i.test(String(res.error))) {
          packages.value = [];
        } else {
          error.value = String(res.error);
          packages.value = [];
        }

        return;
      }
      packages.value = (res?.templates ?? [])
        .filter((t: Record<string, any>) => !t.kind || t.kind === 'package')
        .map((t: Record<string, any>) => toPackageRow(t));
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      packages.value = [];
    } finally {
      isLoading.value = false;
    }
  }

  async function loadInstalled(): Promise<void> {
    try {
      installed.value = await packagesIpc.listInstalled();
    } catch {
      // Installed badges are a nicety — never block browsing on them.
    }
  }

  async function loadDetail(id: string): Promise<void> {
    detailLoading.value = true;
    detailError.value = null;
    detail.value = null;
    try {
      const res = await invoke('marketplace-detail', id);
      if (!res || 'error' in res) {
        detailError.value = String(res?.error ?? 'Could not load that use case.');

        return;
      }
      const { manifest: rawManifest, ...rawRow } = obj(res.template);
      const manifest = obj(rawManifest);

      detail.value = {
        row:           toPackageRow(rawRow, manifest),
        descriptionMd: str(manifest.description_md, obj(manifest.spec).description_md),
        contents:      toContents(manifest),
        templateKind:  str(rawRow.kind),
        raw:           rawRow,
        manifest,
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

  async function install(row: PackageRow): Promise<PackageInstallResult> {
    busySlug.value = row.slug;
    try {
      const res = await packagesIpc.install(row.id);
      if (res?.ok) await loadInstalled();

      return res ?? { ok: false, error: 'No response from the installer.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      busySlug.value = null;
    }
  }

  async function uninstall(slug: string): Promise<PackageUninstallResult> {
    busySlug.value = slug;
    try {
      const res = await packagesIpc.uninstall(slug);
      if (res?.ok) await loadInstalled();

      return res ?? { ok: false, error: 'No response from the installer.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      busySlug.value = null;
    }
  }

  return {
    packages,
    isLoading,
    error,
    detail,
    detailLoading,
    detailError,
    installed,
    installedSlugs,
    busySlug,
    load,
    loadInstalled,
    loadDetail,
    clearDetail,
    install,
    uninstall,
  };
}
