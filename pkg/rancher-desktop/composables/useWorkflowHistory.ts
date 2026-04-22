/**
 * useWorkflowHistory — undo/redo backed by the workflow_history table.
 *
 * The DB is the single source of truth. On mount we pull the history
 * rows for the open workflow; each user save appends a new row to the
 * top, so the list is `[newest, …, oldest]`.
 *
 * Cursor semantics:
 *   - `cursor === 0`  → we're on the latest DB state
 *   - `cursor === N`  → we're N undos behind latest
 *
 * Undo walks the cursor backwards through `history[i].definitionBefore`
 * (the state that existed before save `i` landed). Redo walks it back
 * toward 0; at cursor = 0 we return to `history[0].definitionAfter` —
 * the live head.
 *
 * Restores use the persistence composable's `saveSilent` path so they
 * don't write a new workflow_history row — undo/redo stay invisible in
 * the audit trail.
 *
 * If the user makes a real edit while cursor > 0, call `resetAfterEdit`.
 * That abandons the redo branch (rows above the cursor are still in the
 * DB as historical record — we just stop redoing into them).
 */

import { computed, ref } from 'vue';

import type { WorkflowDefinition } from '@pkg/composables/useWorkflowPersistence';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface WorkflowHistoryRow {
  id:                number;
  workflowId:        string;
  changedBy:         string | null;
  changeReason:      string | null;
  createdAt:         string;
  definitionBefore:  unknown;
  definitionAfter:   unknown;
}

const LOG = '[history]';

export function useWorkflowHistory() {
  const history = ref<WorkflowHistoryRow[]>([]);
  const cursor = ref(0);
  const isLoading = ref(false);

  async function load(workflowId: string): Promise<void> {
    isLoading.value = true;
    try {
      const rows = await ipcRenderer.invoke('workflow-history-get', workflowId, 50);
      history.value = (rows as WorkflowHistoryRow[]) ?? [];
      cursor.value = 0;
      console.log(`${ LOG } load ← ${ history.value.length } rows for ${ workflowId }`);
    } catch (err) {
      console.warn(`${ LOG } load ✗ ${ workflowId }`, err);
      history.value = [];
    } finally {
      isLoading.value = false;
    }
  }

  const canUndo = computed(() => cursor.value < history.value.length);
  const canRedo = computed(() => cursor.value > 0);

  /**
   * Return the definition snapshot we'd land on after pressing undo.
   * Reads `definitionBefore` from the history row one step further back
   * than the current cursor. Null when nothing more to undo.
   */
  function peekUndo(): WorkflowDefinition | null {
    if (!canUndo.value) return null;
    const row = history.value[cursor.value];
    const def = row?.definitionBefore as WorkflowDefinition | null | undefined;

    return def ?? null;
  }

  /**
   * Return the definition snapshot we'd land on after pressing redo.
   * cursor=1 → head of history (definitionAfter of row 0).
   * cursor>1 → definitionBefore of the row at `cursor - 1`.
   */
  function peekRedo(): WorkflowDefinition | null {
    if (!canRedo.value) return null;
    const next = cursor.value - 1;
    if (next === 0) {
      const head = history.value[0]?.definitionAfter as WorkflowDefinition | null | undefined;

      return head ?? null;
    }
    const row = history.value[next];
    const def = row?.definitionBefore as WorkflowDefinition | null | undefined;

    return def ?? null;
  }

  function stepBack(): WorkflowDefinition | null {
    const target = peekUndo();
    if (!target) return null;
    cursor.value += 1;
    console.log(`${ LOG } undo → cursor=${ cursor.value }/${ history.value.length }`);

    return target;
  }

  function stepForward(): WorkflowDefinition | null {
    const target = peekRedo();
    if (!target) return null;
    cursor.value -= 1;
    console.log(`${ LOG } redo → cursor=${ cursor.value }/${ history.value.length }`);

    return target;
  }

  /**
   * Call after a normal user-initiated save. The new save created a
   * fresh history row at the top; we need to refetch so the list is
   * current and reset the cursor to "at head". Any "redo branch" that
   * existed above the cursor is effectively abandoned — those rows
   * remain in the DB as audit record but the UI won't step into them.
   */
  async function resetAfterEdit(workflowId: string): Promise<void> {
    await load(workflowId);
  }

  function reset(): void {
    history.value = [];
    cursor.value = 0;
  }

  return {
    history,
    cursor,
    isLoading,
    canUndo,
    canRedo,
    load,
    peekUndo,
    peekRedo,
    stepBack,
    stepForward,
    resetAfterEdit,
    reset,
  };
}
