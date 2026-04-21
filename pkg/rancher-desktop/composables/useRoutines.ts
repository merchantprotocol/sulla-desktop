/**
 * useRoutines — composable that owns the "My Routines" domain.
 *
 * Responsibility split (MVC-ish):
 *   - MODEL: the WorkflowModel in agent/database/models/WorkflowModel.ts
 *     is the authoritative store. This composable never touches it
 *     directly — all access is through the ipcRenderer bridge.
 *   - CONTROLLER: exposed functions (load, refresh) are the actions
 *     a view triggers.
 *   - VIEW: RoutinesHome.vue consumes the reactive state + computeds
 *     returned here; it has no data-fetching code of its own.
 *
 * Phase 2: `fetchRoutines()` now calls the real `workflow-db-list` IPC
 * handler and maps DB rows into display-ready RoutineSummary objects.
 * The mapper is pragmatic — fields the list query can't answer cheaply
 * (integrations, run history, featured flag) use sensible defaults and
 * are filled in by later phases as we enrich the query.
 */

import { computed, ref } from 'vue';

import type {
  RoutineCategory,
  RoutineStatus,
  RoutineSummary,
  RoutinesStats,
} from '@pkg/types/routines';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Minimal row shape returned by the `workflow-db-list` IPC handler.
 * Mirrors WorkflowListRow in the model so the mapper is the only place
 * that needs to change if either side evolves.
 */
interface DbListRow {
  id:          string;
  name:        string;
  description: string | null;
  status:      'draft' | 'production' | 'archive';
  updatedAt:   string;
  nodeCount:   number;
}

/** Map the DB's coarse status to the richer view status. */
function toRoutineStatus(dbStatus: DbListRow['status']): RoutineStatus {
  switch (dbStatus) {
  case 'draft':      return 'draft';
  case 'archive':    return 'archive';
  case 'production': return 'idle';
    // 'production' means "deployed". Whether it's currently running or
    // scheduled is a runtime fact — Phase 4+ layers live run state over
    // the top. For now a production workflow at rest reads as 'idle'.
  default: return 'idle';
  }
}

function statusLabel(s: RoutineStatus): string {
  const labels: Record<RoutineStatus, string> = {
    running:   'Live',
    scheduled: 'Scheduled',
    idle:      'Idle',
    draft:     'Draft',
    archive:   'Archived',
  };

  return labels[s];
}

/** First letters of the first two words of the name, uppercased, max 2 chars. */
function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Infer a RoutineCategory from the routine name. Until we have a real
 * category column in the workflows table, this gives each strip a
 * colored icon that at least correlates with the routine's purpose.
 * Defaults to 'ops' when nothing matches.
 */
function inferCategory(name: string, description: string | null): RoutineCategory {
  const haystack = `${ name } ${ description ?? '' }`.toLowerCase();
  if (/(blog|article|content|post|video|newsletter|social)/.test(haystack)) return 'content';
  if (/(research|scan|audit|intel|dossier)/.test(haystack)) return 'research';
  if (/(plan|schedule|agenda|priorit)/.test(haystack)) return 'planning';
  if (/(lead|prospect|outreach|crm)/.test(haystack)) return 'leads';
  if (/(learn|think|reflect|memory|identity)/.test(haystack)) return 'learning';
  if (/(goal|forecast|objective|okr)/.test(haystack)) return 'goals';

  return 'ops';
}

function categoryLabel(cat: RoutineCategory): string {
  const labels: Record<RoutineCategory, string> = {
    content:  'Content production',
    research: 'Research',
    planning: 'Planning',
    leads:    'Lead generation',
    learning: 'Learning',
    goals:    'Goals & forecast',
    ops:      'Operations',
  };

  return labels[cat];
}

/** Convert an ISO timestamp into a compact "X ago" display. */
function timeAgo(iso: string): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${ secs }s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${ mins }m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${ hrs }h`;
  const days = Math.floor(hrs / 24);

  return `${ days }d`;
}

/** Convert a DB row to a display-ready RoutineSummary. */
function rowToSummary(row: DbListRow): RoutineSummary {
  const status = toRoutineStatus(row.status);
  const category = inferCategory(row.name, row.description);

  return {
    id:            row.id,
    name:          row.name,
    description:   row.description ?? '',
    category,
    categoryLabel: categoryLabel(category),
    initials:      deriveInitials(row.name),
    status,
    statusLabel:   statusLabel(status),
    agents:        row.nodeCount,
    integrations:  [],      // TODO: surface from definition when we enrich the query
    lastRunAgo:    timeAgo(row.updatedAt),
    // Runtime metrics (runsPerWeek, avgCycle, costPerRun, schedule,
    // featured) come from run history + trigger analysis in later phases.
  };
}

async function fetchRoutines(): Promise<RoutineSummary[]> {
  const rows = await ipcRenderer.invoke('workflow-db-list');

  return rows.map(rowToSummary);
}

/**
 * Aggregate run stats for the hero band. Phase 2 returns placeholder
 * values; run-history aggregation is a separate concern we'll plug in
 * once runs start landing in Postgres.
 */
function computeStats(routines: RoutineSummary[]): RoutinesStats {
  if (routines.length === 0) {
    return {
      runs: '0', artifacts: '0', reclaimed: '0h', spend: '$0',
    };
  }

  return {
    runs:      '—',
    artifacts: '—',
    reclaimed: '—',
    spend:     '—',
  };
}

export function useRoutines() {
  const routines = ref<RoutineSummary[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      routines.value = await fetchRoutines();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      routines.value = [];
    } finally {
      isLoading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    return load();
  }

  // Grouped views — keep the template free of filter logic.
  const running = computed(() =>
    routines.value.filter(r => r.status === 'running'));
  const scheduled = computed(() =>
    routines.value.filter(r => r.status === 'scheduled'));
  // Idle now means "in the wings but still active" — drafts included,
  // archived excluded. Archived routines get their own tab.
  const idle = computed(() =>
    routines.value.filter(r => ['idle', 'draft'].includes(r.status)));
  const archived = computed(() =>
    routines.value.filter(r => r.status === 'archive'));

  const stats = computed<RoutinesStats>(() => computeStats(routines.value));
  // "Empty" now reflects the My Routines tab — if every routine you own
  // is archived, we still want the My Routines empty state so the user
  // is guided toward templates / new routines, not staring at Act sections
  // with nothing in them.
  const isEmpty = computed(() => {
    if (isLoading.value) return false;
    const nonArchived = routines.value.filter(r => r.status !== 'archive');

    return nonArchived.length === 0;
  });

  return {
    // state
    routines,
    isLoading,
    isEmpty,
    error,

    // grouped views
    running,
    scheduled,
    idle,
    archived,

    // derived
    stats,

    // actions
    load,
    refresh,
  };
}
