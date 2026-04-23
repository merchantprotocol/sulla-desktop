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

/** Real on-disk kinds. These are what loaders actually fetch. */
export type LibraryArtifactKind = 'routines' | 'skills' | 'functions' | 'recipes';

/** Selectable views in the Library left rail. `all` is synthetic — it
 *  flattens every artifact kind into one list with a `kind` tag on each
 *  item so the UI can show kind pills and the user can scan across
 *  everything they own at once. */
export type LibraryKind = 'all' | LibraryArtifactKind;

const ARTIFACT_KINDS: LibraryArtifactKind[] = ['routines', 'skills', 'functions', 'recipes'];

export interface LibraryItem {
  /** Stable directory name on disk — also the primary key within a kind. */
  slug:        string;
  name:        string;
  description: string;
  version?:    string;
  updatedAt?:  string;
  /** Kind-specific key/value pairs rendered as chips on the strip. */
  meta:        Array<{ label: string; value: string }>;
  /** Artifact kind. Always populated by the loaders so the "All" view
   *  can render a kind pill on mixed rows; kind-specific views ignore it. */
  kind?:       LibraryArtifactKind;
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
      kind:        'routines' as const,
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
      kind:        'skills' as const,
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
      kind:        'functions' as const,
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
      kind:        'recipes' as const,
    };
  });
}

const LOADERS: Record<LibraryArtifactKind, () => Promise<LibraryItem[]>> = {
  routines:  loadRoutines,
  skills:    loadSkills,
  functions: loadFunctions,
  recipes:   loadRecipes,
};

// ── Singleton state ──
// The Library tab and RoutinesHome both need the same counts. Rather than
// make each caller maintain its own copy, everything lives at module
// scope and `useLibrary()` just returns bindings onto it. First caller to
// mount triggers loadAll(); later callers see the cached state instantly.
const activeKind = ref<LibraryKind>('all');
const search     = ref('');

const states = ref<Record<LibraryArtifactKind, LibraryKindState>>({
  routines:  emptyKindState(),
  skills:    emptyKindState(),
  functions: emptyKindState(),
  recipes:   emptyKindState(),
});

// Tracks whether a full cross-kind load has ever been requested, so
// RoutinesHome's badge hydration doesn't fire N redundant parallel loads.
let loadAllPromise: Promise<void> | null = null;

async function loadKind(kind: LibraryArtifactKind): Promise<void> {
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
  if (loadAllPromise) return loadAllPromise;
  loadAllPromise = Promise.all(ARTIFACT_KINDS.map(loadKind)).then(() => {});
  try {
    await loadAllPromise;
  } finally {
    // Allow a fresh reload later (e.g. after user publishes) by clearing
    // the cache. The individual `states[kind].items` arrays stay warm in
    // the meantime.
    loadAllPromise = null;
  }
}

async function setKind(kind: LibraryKind): Promise<void> {
  activeKind.value = kind;
  if (kind === 'all') {
    // All-view aggregates every kind; kick the loader when any of them
    // are still empty. Idempotent thanks to `loadAllPromise`.
    if (ARTIFACT_KINDS.some(k => states.value[k].items.length === 0 && !states.value[k].error)) {
      await loadAll();
    }
    return;
  }
  if (states.value[kind].items.length === 0 && !states.value[kind].error) {
    await loadKind(kind);
  }
}

// ── Derived views ──

// Aggregated state used by the "All" view. Loading is the union of
// per-kind loaders; error surfaces the first kind that broke so the user
// gets actionable feedback instead of a silent partial list.
const allItems = computed<LibraryItem[]>(() => {
  const out: LibraryItem[] = [];
  for (const k of ARTIFACT_KINDS) out.push(...states.value[k].items);
  return out;
});

const allState = computed<LibraryKindState>(() => ({
  items:     allItems.value,
  isLoading: ARTIFACT_KINDS.some(k => states.value[k].isLoading),
  error:     ARTIFACT_KINDS.map(k => states.value[k].error).find(Boolean) ?? null,
}));

const activeState = computed<LibraryKindState>(() => {
  return activeKind.value === 'all' ? allState.value : states.value[activeKind.value];
});

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

const kindCounts = computed<Record<LibraryArtifactKind, number>>(() => ({
  routines:  states.value.routines.items.length,
  skills:    states.value.skills.items.length,
  functions: states.value.functions.items.length,
  recipes:   states.value.recipes.items.length,
}));

const totalCount = computed<number>(() => {
  const c = kindCounts.value;
  return c.routines + c.skills + c.functions + c.recipes;
});

export function useLibrary() {
  return {
    // state
    activeKind,
    search,
    states,
    activeState,
    filteredItems,
    kindCounts,
    totalCount,

    // actions
    loadAll,
    loadKind,
    setKind,
  };
}
