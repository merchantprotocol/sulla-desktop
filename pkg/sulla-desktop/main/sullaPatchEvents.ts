// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * sullaPatchEvents.ts — IPC surface for reverting post-hoc file patches
 * surfaced in the new chat's PatchBlock.vue.
 *
 * The chat emits a `patch:revert` invoke from the renderer when the user
 * clicks Revert on an APPLIED PatchBlock. `revertMeta` carries enough
 * state (Edit old/new strings, or Write old content) for this handler to
 * undo the change without re-invoking Claude Code.
 *
 * Safety:
 *   - `op: 'edit'` does a single string replace of newString → oldString.
 *     If the file has been modified past the edit region, the replace is
 *     a no-op and we return an error instead of writing a corrupted file.
 *   - `op: 'write'` writes the captured oldContent back verbatim. This
 *     is only safe when we snapshotted before the Write — the caller
 *     guarantees that by emitting revertMeta at tool_use time.
 *   - Paths are not sandboxed beyond existence checks because Claude
 *     Code has already been given disk access (by running with
 *     --dangerously-skip-permissions). Revert operates within that same
 *     trust boundary.
 */

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

type RevertMeta =
  | { op: 'edit';  path: string; oldString: string; newString: string }
  | { op: 'write'; path: string; oldContent: string };

type RevertResult = { ok: true } | { ok: false; error: string };

export interface PatchRevertFiles {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<unknown>;
}

export interface PatchRevertLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** patch:revert — undo an applied PatchBlock edit or write. */
export class SullaPatchIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly fs: PatchRevertFiles, private readonly log: PatchRevertLogger) {}

  register(): void {
    this.ipc.handle('patch:revert', (_event, meta: RevertMeta) => this.revert(meta));
  }

  async revert(meta: RevertMeta): Promise<RevertResult> {
    const { fs, log } = this;
    if (!meta || typeof meta !== 'object') {
      return { ok: false, error: 'missing revert metadata' };
    }
    if (!meta.path || typeof meta.path !== 'string') {
      return { ok: false, error: 'missing target path' };
    }

    try {
      if (meta.op === 'edit') {
        const current = await fs.readFile(meta.path, 'utf-8');
        // String.replace with a string argument replaces only the first
        // occurrence — exactly what Claude Code's Edit tool does forward,
        // so the reverse is well-defined.
        if (!current.includes(meta.newString)) {
          return { ok: false, error: 'cannot revert: file no longer contains the new text (it may have been edited again)' };
        }
        const next = current.replace(meta.newString, meta.oldString);
        await fs.writeFile(meta.path, next, 'utf-8');
        log.log(`[patch:revert] edit reverted for ${ meta.path }`);
        return { ok: true };
      }

      if (meta.op === 'write') {
        await fs.writeFile(meta.path, meta.oldContent, 'utf-8');
        log.log(`[patch:revert] write reverted for ${ meta.path } (${ meta.oldContent.length } bytes restored)`);
        return { ok: true };
      }

      return { ok: false, error: `unknown revert op: ${ (meta as any).op }` };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      log.warn(`[patch:revert] failed for ${ meta.path }: ${ message }`);
      return { ok: false, error: message };
    }
  }
}
