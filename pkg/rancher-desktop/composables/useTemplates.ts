/**
 * useTemplates — composable that owns the "My Templates" domain.
 *
 * Templates live on disk at `~/sulla/routines/<slug>/routine.yaml` —
 * each is a full routine DAG. This composable reads that registry via
 * the `routines-template-list` IPC handler and exposes a searchable
 * list to the view.
 *
 * Instantiating a template deep-clones the full routine document into
 * a new row in the workflows table and returns its id. The view then
 * navigates to edit mode on that id.
 */

import { computed, ref } from 'vue';

import type { RoutineCategory, TemplateSummary } from '@pkg/types/routines';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Row shape returned by `routines-template-list`. Mirrors the handler's
 * `TemplateSummaryRow` verbatim — keep the two in sync if either moves.
 */
interface TemplateRow {
  slug:         string;
  id:           string;
  name:         string;
  description:  string;
  version:      string;
  nodeCount:    number;
  edgeCount:    number;
  triggerTypes: string[];
  updatedAt:    string;
}

/** First letters of the first two words of the name, uppercased. */
function deriveInitials(name: string, slug: string): string {
  const source = name || slug;
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Infer a RoutineCategory from the routine's name + description so the
 * card still gets a coloured icon. The routine schema doesn't carry a
 * category column, so we keyword-match — same pattern useRoutines uses
 * for database rows.
 */
function inferCategory(name: string, description: string): RoutineCategory {
  const haystack = `${ name } ${ description }`.toLowerCase();
  if (/(blog|article|content|post|video|newsletter|social)/.test(haystack)) return 'content';
  if (/(research|scan|audit|intel|dossier)/.test(haystack)) return 'research';
  if (/(plan|schedule|agenda|priorit)/.test(haystack)) return 'planning';
  if (/(lead|prospect|outreach|crm)/.test(haystack)) return 'leads';
  if (/(learn|think|reflect|memory|identity)/.test(haystack)) return 'learning';
  if (/(goal|forecast|objective|okr)/.test(haystack)) return 'goals';

  return 'ops';
}

function rowToSummary(row: TemplateRow): TemplateSummary {
  return {
    slug:         row.slug,
    id:           row.id,
    name:         row.name,
    description:  row.description,
    version:      row.version,
    initials:     deriveInitials(row.name, row.slug),
    category:     inferCategory(row.name, row.description),
    nodeCount:    row.nodeCount,
    edgeCount:    row.edgeCount,
    triggerTypes: row.triggerTypes,
    updatedAt:    row.updatedAt || undefined,
  };
}

async function fetchTemplates(): Promise<TemplateSummary[]> {
  const rows = await ipcRenderer.invoke('routines-template-list');

  return rows.map(rowToSummary);
}

async function instantiateTemplate(slug: string): Promise<string> {
  const result = await ipcRenderer.invoke('routines-template-instantiate', slug);

  return result.id;
}

function matchesQuery(tpl: TemplateSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();

  return tpl.name.toLowerCase().includes(needle) ||
    tpl.description.toLowerCase().includes(needle) ||
    tpl.triggerTypes.some(t => t.toLowerCase().includes(needle)) ||
    tpl.category.toLowerCase().includes(needle);
}

export function useTemplates() {
  const templates = ref<TemplateSummary[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const search = ref('');

  async function load(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      templates.value = await fetchTemplates();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      templates.value = [];
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Clone a template into the database as a new routine.
   * Returns the new routine id so the view can navigate to edit mode.
   * Throws on failure — caller is responsible for surfacing the error.
   */
  function instantiate(slug: string): Promise<string> {
    return instantiateTemplate(slug);
  }

  const filtered = computed(() =>
    templates.value.filter(t => matchesQuery(t, search.value.trim())));

  const isEmpty = computed(() => !isLoading.value && templates.value.length === 0);
  const hasNoMatches = computed(() =>
    !isLoading.value && templates.value.length > 0 && filtered.value.length === 0);

  return {
    // state
    templates,
    search,
    isLoading,
    isEmpty,
    hasNoMatches,
    error,

    // derived
    filtered,

    // actions
    load,
    instantiate,
  };
}
