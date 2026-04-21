/**
 * useTemplates — composable that owns the "My Templates" domain.
 *
 * Templates live on disk at ~/sulla/routines/<slug>/routine.yaml — each
 * one its own git repo. This composable reads that registry via the
 * `routines-template-list` IPC handler and exposes a searchable list
 * to the view.
 *
 * Instantiating a template means: read its routine.yaml, build a
 * minimal workflow graph that wraps it (manual trigger → routine node),
 * upsert a fresh row into the workflows table, return the new routine
 * id. The view then navigates to edit mode on that id.
 *
 * MVC split mirrors useRoutines: this file is the controller, the IPC
 * handler in main/sullaRoutineTemplateEvents.ts is the model boundary,
 * and RoutinesHome.vue is the view.
 */

import { computed, ref } from 'vue';

import type { RoutineCategory, TemplateSummary } from '@pkg/types/routines';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Row shape returned by the main-process handler. Wider than the
 * TemplateSummary the view consumes — the mapper narrows it and maps
 * the free-form `category` string to a typed RoutineCategory.
 */
interface TemplateRow {
  slug:        string;
  name:        string;
  description: string;
  version:     string;
  section:     string;
  category:    string;
  runtime:     string | null;
  tags:        string[];
  inputCount:  number;
  outputCount: number;
  permissions: string;
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
 * Map the manifest's free-form `category` string onto the typed
 * RoutineCategory union used by the view. Unknown values fall through
 * to `ops` so every strip still gets a colored icon.
 */
function normaliseCategory(raw: string): RoutineCategory {
  const slug = raw.trim().toLowerCase();
  const map: Record<string, RoutineCategory> = {
    content:    'content',
    research:   'research',
    planning:   'planning',
    leads:      'leads',
    'lead gen': 'leads',
    learning:   'learning',
    goals:      'goals',
    forecast:   'goals',
    ops:        'ops',
    operations: 'ops',
    network:    'ops',
    core:       'ops',
  };

  return map[slug] ?? 'ops';
}

function rowToSummary(row: TemplateRow): TemplateSummary {
  return {
    slug:        row.slug,
    name:        row.name,
    description: row.description,
    category:    normaliseCategory(row.category),
    section:     row.section,
    initials:    deriveInitials(row.name, row.slug),
    version:     row.version,
    runtime:     row.runtime ?? undefined,
    tags:        row.tags,
    inputCount:  row.inputCount,
    outputCount: row.outputCount,
    permissions: row.permissions,
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
    tpl.tags.some(tag => tag.toLowerCase().includes(needle)) ||
    tpl.category.toLowerCase().includes(needle) ||
    tpl.section.toLowerCase().includes(needle);
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
