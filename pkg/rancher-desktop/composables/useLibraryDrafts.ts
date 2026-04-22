/**
 * useLibraryDrafts — composable for Studio → Library → Drafts.
 *
 * Fronts the DB-backed editable copies (library_drafts table). The
 * fork action is exposed here so other surfaces (the detail drawer in
 * LibraryTab) can reuse the same loading/error flow.
 */

import { computed, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type DraftKind = 'skill' | 'function' | 'recipe';

export interface DraftSummary {
  id:         string;
  kind:       DraftKind;
  slug:       string;
  base_slug:  string | null;
  name:       string;
  updated_at: string;
}

export interface DraftDetail {
  id:            string;
  kind:          DraftKind;
  slug:          string;
  base_slug:     string | null;
  manifest_json: Record<string, unknown>;
  files_json:    Record<string, string>;
  created_at:    string;
  updated_at:    string;
}

function errOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useLibraryDrafts() {
  const drafts    = ref<DraftSummary[]>([]);
  const isLoading = ref(false);
  const loadError = ref<string | null>(null);

  const active       = ref<DraftDetail | null>(null);
  const activeLoading = ref(false);
  const activeError   = ref<string | null>(null);
  const saving        = ref(false);
  const saveError     = ref<string | null>(null);

  const publishing      = ref<'local' | 'marketplace' | null>(null);
  const publishError    = ref<string | null>(null);
  const publishResult   = ref<
    | { type: 'local';       path: string; slug: string }
    | { type: 'marketplace'; templateId: string; bundleStatus: string }
    | null
  >(null);

  async function load(kind?: DraftKind): Promise<void> {
    isLoading.value = true;
    loadError.value = null;
    try {
      drafts.value = await ipcRenderer.invoke('library-drafts-list', kind);
    } catch (err) {
      loadError.value = errOf(err);
      drafts.value = [];
    } finally {
      isLoading.value = false;
    }
  }

  async function loadDetail(id: string): Promise<void> {
    activeLoading.value = true;
    activeError.value = null;
    active.value = null;
    publishResult.value = null;
    try {
      const res = await ipcRenderer.invoke('library-draft-get', id);
      if ('error' in res) {
        activeError.value = res.error;

        return;
      }
      active.value = res;
    } catch (err) {
      activeError.value = errOf(err);
    } finally {
      activeLoading.value = false;
    }
  }

  function closeDetail(): void {
    active.value = null;
    activeError.value = null;
    saveError.value = null;
    publishError.value = null;
    publishResult.value = null;
  }

  async function save(patch: {
    slug?:          string;
    manifest_json?: Record<string, unknown>;
    files_json?:    Record<string, string>;
  }): Promise<boolean> {
    if (!active.value) return false;
    saving.value = true;
    saveError.value = null;
    try {
      const res = await ipcRenderer.invoke('library-draft-save', active.value.id, patch);
      if ('error' in res) {
        saveError.value = res.error;

        return false;
      }
      // Apply patch locally so the form stays bound to the latest state
      // without a round-trip fetch.
      const current = active.value;
      active.value = {
        ...current,
        slug:          patch.slug          ?? current.slug,
        manifest_json: patch.manifest_json ?? current.manifest_json,
        files_json:    patch.files_json    ?? current.files_json,
        updated_at:    new Date().toISOString(),
      };

      return true;
    } catch (err) {
      saveError.value = errOf(err);

      return false;
    } finally {
      saving.value = false;
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      const res = await ipcRenderer.invoke('library-draft-delete', id);
      if ('error' in res) {
        loadError.value = res.error;

        return false;
      }
      drafts.value = drafts.value.filter(d => d.id !== id);
      if (active.value?.id === id) closeDetail();

      return true;
    } catch (err) {
      loadError.value = errOf(err);

      return false;
    }
  }

  async function publishLocal(targetSlug?: string): Promise<boolean> {
    if (!active.value) return false;
    publishing.value = 'local';
    publishError.value = null;
    publishResult.value = null;
    try {
      const res = await ipcRenderer.invoke('library-draft-publish-local', active.value.id, targetSlug);
      if ('error' in res) {
        publishError.value = res.error;

        return false;
      }
      publishResult.value = { type: 'local', path: res.path, slug: res.slug };

      return true;
    } catch (err) {
      publishError.value = errOf(err);

      return false;
    } finally {
      publishing.value = null;
    }
  }

  async function publishMarketplace(): Promise<boolean> {
    if (!active.value) return false;
    publishing.value = 'marketplace';
    publishError.value = null;
    publishResult.value = null;
    try {
      const res = await ipcRenderer.invoke('library-draft-publish-marketplace', active.value.id);
      if ('error' in res) {
        publishError.value = res.error;

        return false;
      }
      publishResult.value = { type: 'marketplace', templateId: res.templateId, bundleStatus: res.bundleStatus };

      return true;
    } catch (err) {
      publishError.value = errOf(err);

      return false;
    } finally {
      publishing.value = null;
    }
  }

  const isEmpty = computed(() => !isLoading.value && drafts.value.length === 0);

  return {
    // list state
    drafts,
    isLoading,
    isEmpty,
    loadError,

    // detail state
    active,
    activeLoading,
    activeError,
    saving,
    saveError,

    // publish state
    publishing,
    publishError,
    publishResult,

    // actions
    load,
    loadDetail,
    closeDetail,
    save,
    remove,
    publishLocal,
    publishMarketplace,
  };
}
