/**
 * useLibrary — composable for Studio → Library.
 *
 * Reads the four on-disk registries (routines/skills/functions/recipes)
 * via existing IPC handlers and normalises each kind's rows into a
 * shared `LibraryItem` shape so the UI can render them with a single
 * strip component. Kind-specific fields (node/edge counts for routines,
 * runtime for functions, image for recipes, etc.) live on `meta` and
 * are rendered as chips.
 *
 * The composable owns all four lists + the active kind + search. Each
 * panel in the Library tab binds to the same composable; switching kind
 * is zero-cost because everything is preloaded.
 */

import { computed, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type LibraryKind = 'routines' | 'skills' | 'functions' | 'recipes';

export interface LibraryItem {
  /** Stable directory name on disk — also the primary key within a kind. */
  slug:        string;
  name:        string;
  description: string;
  version?:    string;
  updatedAt?:  string;
  /** Kind-specific key/value pairs rendered as chips on the strip. */
  meta:        Array<{ label: string; value: string }>;
}

export interface LibraryKindState {
  items:     LibraryItem[];
  isLoading: boolean;
  error:     string | null;
}

function emptyKindState(): LibraryKindState {
  return { items: [], isLoading: false, error: null };
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadRoutines(): Promise<LibraryItem[]> {
  const rows = await ipcRenderer.invoke('routines-template-list');

  return rows.map((r) => {
    const meta: LibraryItem['meta'] = [
      { label: 'Nodes', value: String(r.nodeCount) },
      { label: 'Edges', value: String(r.edgeCount) },
    ];
    if (r.triggerTypes?.length) meta.push({ label: 'Triggers', value: r.triggerTypes.join(', ') });
    if (r.requiredIntegrations?.length) meta.push({ label: 'Integrations', value: r.requiredIntegrations.join(', ') });
    if (r.requiredFunctions?.length) meta.push({ label: 'Functions', value: r.requiredFunctions.join(', ') });

    return {
      slug:        r.slug,
      name:        r.name,
      description: r.summary || r.description,
      version:     r.version,
      updatedAt:   r.updatedAt,
      meta,
    };
  });
}

async function loadSkills(): Promise<LibraryItem[]> {
  const rows = await ipcRenderer.invoke('library-list-skills');

  return rows.map((r) => {
    const meta: LibraryItem['meta'] = [
      { label: 'Prompt', value: `${ r.promptLength } chars` },
    ];
    if (r.category) meta.push({ label: 'Category', value: r.category });
    if (r.condition) meta.push({ label: 'Condition', value: r.condition });

    return {
      slug:        r.slug,
      name:        r.name,
      description: r.description,
      updatedAt:   r.updatedAt,
      meta,
    };
  });
}

async function loadFunctions(): Promise<LibraryItem[]> {
  const rows = await ipcRenderer.invoke('functions-list');

  return rows.map((r) => {
    const meta: LibraryItem['meta'] = [
      { label: 'Runtime', value: r.runtime },
    ];
    const inputKeys = Object.keys(r.inputs || {});
    const outputKeys = Object.keys(r.outputs || {});
    if (inputKeys.length) meta.push({ label: 'Inputs', value: String(inputKeys.length) });
    if (outputKeys.length) meta.push({ label: 'Outputs', value: String(outputKeys.length) });
    if (r.integrations?.length) meta.push({ label: 'Integrations', value: r.integrations.map(i => i.slug).join(', ') });

    return {
      slug:        r.slug,
      name:        r.name,
      description: r.description,
      meta,
    };
  });
}

async function loadRecipes(): Promise<LibraryItem[]> {
  const rows = await ipcRenderer.invoke('library-list-recipes');

  return rows.map((r) => {
    const meta: LibraryItem['meta'] = [];
    if (r.extension) meta.push({ label: 'Extension', value: r.extension });
    if (r.image) meta.push({ label: 'Image', value: r.image });

    return {
      slug:        r.slug,
      name:        r.name,
      description: r.description,
      version:     r.version,
      updatedAt:   r.updatedAt,
      meta,
    };
  });
}

const LOADERS: Record<LibraryKind, () => Promise<LibraryItem[]>> = {
  routines:  loadRoutines,
  skills:    loadSkills,
  functions: loadFunctions,
  recipes:   loadRecipes,
};

export function useLibrary() {
  const activeKind = ref<LibraryKind>('routines');
  const search     = ref('');

  const states = ref<Record<LibraryKind, LibraryKindState>>({
    routines:  emptyKindState(),
    skills:    emptyKindState(),
    functions: emptyKindState(),
    recipes:   emptyKindState(),
  });

  async function loadKind(kind: LibraryKind): Promise<void> {
    const st = states.value[kind];
    st.isLoading = true;
    st.error = null;
    try {
      st.items = await LOADERS[kind]();
    } catch (err) {
      st.error = msgOf(err);
      st.items = [];
    } finally {
      st.isLoading = false;
    }
  }

  async function loadAll(): Promise<void> {
    await Promise.all((Object.keys(LOADERS) as LibraryKind[]).map(loadKind));
  }

  async function setKind(kind: LibraryKind): Promise<void> {
    activeKind.value = kind;
    // Lazy-refresh if this kind has never been loaded — keeps tab switches snappy.
    if (states.value[kind].items.length === 0 && !states.value[kind].error) {
      await loadKind(kind);
    }
  }

  const activeState = computed<LibraryKindState>(() => states.value[activeKind.value]);

  const filteredItems = computed<LibraryItem[]>(() => {
    const q = search.value.trim().toLowerCase();
    const items = activeState.value.items;
    if (!q) return items;

    return items.filter(it =>
      it.name.toLowerCase().includes(q) ||
      it.description.toLowerCase().includes(q) ||
      it.slug.toLowerCase().includes(q) ||
      it.meta.some(m => m.value.toLowerCase().includes(q)));
  });

  const kindCounts = computed<Record<LibraryKind, number>>(() => ({
    routines:  states.value.routines.items.length,
    skills:    states.value.skills.items.length,
    functions: states.value.functions.items.length,
    recipes:   states.value.recipes.items.length,
  }));

  return {
    // state
    activeKind,
    search,
    states,
    activeState,
    filteredItems,
    kindCounts,

    // actions
    loadAll,
    loadKind,
    setKind,
  };
}
