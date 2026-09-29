/**
 * sullaReflexEvents.ts — IPC surface for live intent in the chat composer.
 *
 *   reflex:preview  (text) → ReflexPreview | null
 *     Called (debounced) as the human types. Read-only — no decision row,
 *     no tool call — so it is safe per keystroke. Non-null only when Reflex
 *     would actually act on this text if it were sent.
 *
 *   reflex:run      (text) → { ok, label, summary } | { ok: false, error }
 *     The human accepted the suggestion (Tab). Runs through runReflex, the
 *     same path a sent chat message takes, so policy, approval gating, and
 *     the reflex_decisions receipt are identical.
 *
 *   reflex:forget   (exampleIds) → { ok, forgotten } | { ok: false, error }
 *     Undo on a "⚡ Learned" chat note. Soft-archives exactly the examples
 *     that note announced (ReflexModel.forget), so they stop influencing
 *     predictions but stay in training history.
 */

import { ipcMain } from 'electron';

import Logging from '@pkg/utils/logging';

const log = Logging.background;

const MAX_PREVIEW_CHARS = 300;
const MAX_FORGET_IDS = 10;

export function initSullaReflexEvents(): void {
  ipcMain.handle('reflex:preview', async(_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_PREVIEW_CHARS) return null;
    const { previewReflex } = await import('@pkg/agent/reflex/ReflexService');
    return previewReflex(text);
  });

  ipcMain.handle('reflex:run', async(_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' };
    const { runReflex, reflexActionLabel } = await import('@pkg/agent/reflex/ReflexService');
    const result: any = await runReflex(text, undefined);
    if (!result || result.kind === 'hint') {
      return { ok: false, error: 'Reflex is no longer confident about this — send it to Sulla instead.' };
    }
    log.log(`[reflex:run] composer accepted ${ result.toolName } (confidence ${ result.confidence }) → ${ result.success ? 'ok' : 'failed' }`);
    return result.success
      ? { ok: true, label: reflexActionLabel(result.toolName, result.params), summary: result.summary }
      : { ok: false, error: result.summary || 'the action failed' };
  });

  ipcMain.handle('reflex:forget', async(_event, ids: unknown) => {
    const exampleIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id.trim()) : [];
    if (!exampleIds.length || exampleIds.length > MAX_FORGET_IDS) return { ok: false, error: 'invalid example ids' };
    try {
      const { ReflexModel } = await import('@pkg/agent/database/models/ReflexModel');
      let forgotten = 0;
      for (const id of exampleIds) {
        if (await ReflexModel.forget(id.trim())) forgotten++;
      }
      log.log(`[reflex:forget] undo archived ${ forgotten }/${ exampleIds.length } example(s)`);
      return forgotten ? { ok: true, forgotten } : { ok: false, error: 'Nothing to undo — already forgotten.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
