/**
 * useWorkflowPersistence — owns the round-trip between the canvas
 * editor and the workflow store (Postgres + YAML-on-disk).
 *
 * Responsibility split:
 *   - MODEL: WorkflowModel in agent/database/models/WorkflowModel.ts
 *     + the YAML files under ~/sulla/resources/workflows/. Both are
 *     the truth; `workflow-save` dual-writes to keep them in sync.
 *   - CONTROLLER: this composable. Loads a workflow by id, queues
 *     debounced saves, reports progress via a status ref.
 *   - VIEW: AgentRoutines.vue hydrates its editable refs from the
 *     loaded definition and calls `scheduleSave` whenever the user
 *     mutates the graph.
 *
 * The composable is deliberately thin: it does not watch any caller
 * state on its own. The caller decides which mutations should trigger
 * a save — that keeps the data flow explicit and avoids accidental
 * saves during hydration.
 */

import { readonly, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type PersistenceStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error';

/** The authoritative shape of a workflow as the store round-trips it. */
export interface WorkflowDefinition {
  id:            string;
  name?:         string;
  description?:  string;
  version?:      string;
  enabled?:      boolean;
  nodes?:        unknown[];
  edges?:        unknown[];
  viewport?:     { x: number; y: number; zoom: number };
  createdAt?:    string;
  updatedAt?:    string;
  _status?:      'draft' | 'production' | 'archive';
  // Anything else the YAML carries (author, license, trust, etc.) is
  // preserved verbatim by the save path.
  [key: string]: unknown;
}

const DEFAULT_DEBOUNCE_MS = 800;
const SAVED_FLASH_MS = 1600;

export function useWorkflowPersistence(options: { debounceMs?: number } = {}) {
  const status = ref<PersistenceStatus>('idle');
  const error = ref<string | null>(null);
  const lastSavedAt = ref<number | null>(null);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPayload: WorkflowDefinition | null = null;
  let inFlight: Promise<void> | null = null;

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  async function load(id: string): Promise<WorkflowDefinition | null> {
    status.value = 'loading';
    error.value = null;
    try {
      const def = await ipcRenderer.invoke('workflow-db-get', id);
      status.value = 'idle';

      return def as WorkflowDefinition | null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      status.value = 'error';

      return null;
    }
  }

  async function flush(): Promise<void> {
    if (!pendingPayload) return;
    const payload = pendingPayload;
    pendingPayload = null;

    status.value = 'saving';
    try {
      await ipcRenderer.invoke('workflow-save', payload);
      error.value = null;
      lastSavedAt.value = Date.now();
      status.value = 'saved';

      // After a beat, fall back to idle — the "saved" flash is a
      // transient confirmation, not a persistent state.
      if (savedFlashTimer) clearTimeout(savedFlashTimer);
      savedFlashTimer = setTimeout(() => {
        if (status.value === 'saved') status.value = 'idle';
      }, SAVED_FLASH_MS);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      status.value = 'error';
    }
  }

  /**
   * Queue a save. Multiple calls within `debounceMs` coalesce into a
   * single flush — the latest payload wins. While a flush is in flight,
   * additional calls stack on top of it; the tail save runs only when
   * the current one resolves.
   */
  function scheduleSave(payload: WorkflowDefinition): void {
    pendingPayload = payload;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async() => {
      saveTimer = null;
      // Wait for any in-flight save to land before starting the next
      // one — avoids racing the same workflow into the store twice.
      if (inFlight) await inFlight;
      inFlight = flush();
      await inFlight;
      inFlight = null;
    }, debounceMs);
  }

  /**
   * Force an immediate save (e.g. on unmount). Resolves after the store
   * acknowledges the write — caller may await to guarantee durability.
   */
  async function saveNow(payload: WorkflowDefinition): Promise<void> {
    pendingPayload = payload;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (inFlight) await inFlight;
    inFlight = flush();
    await inFlight;
    inFlight = null;
  }

  function cancel(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (savedFlashTimer) {
      clearTimeout(savedFlashTimer);
      savedFlashTimer = null;
    }
    pendingPayload = null;
  }

  return {
    status:       readonly(status),
    error:        readonly(error),
    lastSavedAt:  readonly(lastSavedAt),
    load,
    scheduleSave,
    saveNow,
    cancel,
  };
}
