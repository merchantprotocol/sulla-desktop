// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesBrowserState } from './FilesBrowserState';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry, TrashDisplayEntry } from './FilesBrowserTypes';

/** Restore and permanent deletion from Trash, one exact tombstone at a time, folders first. */
export class FilesBrowserTrash {
  constructor(private readonly browser:FilesBrowserController) {}

  private static tombstoned(entries:DisplayEntry[]):TrashDisplayEntry[] { return entries.filter((entry):entry is TrashDisplayEntry => Boolean(entry.trashItem)) }

  /** Folders are processed before files so a restored/purged folder settles its children first. */
  private static foldersFirst(entries:TrashDisplayEntry[]):TrashDisplayEntry[] { return [...entries].sort((left, right) => Number(right.trashItem.kind === 'folder') - Number(left.trashItem.kind === 'folder')) }

  readonly restoreSelected = async():Promise<void> => {
    const state = this.browser.state;
    const entries = FilesBrowserTrash.tombstoned(this.browser.selection.selectedEntries.value);
    const restore = state.props.dataSource.restoreTrashItem?.bind(state.props.dataSource);

    if (!entries.length || state.section.value !== 'trash' || !restore) return;
    await this.browser.refresher.runMutation(async() => {
      let restored = 0; let notAttempted = 0; let pending = FilesBrowserTrash.foldersFirst(entries); const failures:string[] = [];

      while (pending.length) {
        const entry = pending.shift()!;

        try { await restore(entry.trashItem); restored++ } catch (cause) {
          failures.push(`${ entry.name }: ${ FilesBrowserState.messageOf(cause) }`);
          if (entry.trashItem.kind === 'folder') { notAttempted = pending.length; break }
          continue;
        }
        if (entry.trashItem.kind === 'folder' && pending.length) {
          try { pending = await this.authoritativeTrashEntries(pending) } catch (cause) { failures.push(`Trash refresh: ${ FilesBrowserState.messageOf(cause) }`); notAttempted = pending.length; break }
        }
      }
      state.operationNotice.value = restored ? `${ restored } item${ restored === 1 ? '' : 's' } restored from their exact Trash tombstone.` : '';
      state.operationError.value = [failures.length ? `${ failures.length } item${ failures.length === 1 ? '' : 's' } not restored. ${ failures.join(' · ') }` : '', notAttempted ? `${ notAttempted } remaining item${ notAttempted === 1 ? ' was' : 's were' } retained without an attempt.` : ''].filter(Boolean).join(' ');
      state.selectedKeys.value = new Set(); this.browser.menus.closeActions(false);
    });
  };

  /** FileDetail reports the outcome of trashing or restoring the open file. */
  readonly onTrashDetailOutcome = async(message:string):Promise<void> => {
    const state = this.browser.state;

    state.selected.value = null;
    state.operationError.value = message;
    await this.browser.refresher.refresh(true);
  };

  async purgeEntries(entries:DisplayEntry[], all = false):Promise<void> {
    const state = this.browser.state; const source = state.props.dataSource;

    if (state.busy.value || state.loading.value || state.section.value !== 'trash' || !source.purgeTrashItem) return;
    const purge = source.purgeTrashItem.bind(source);
    const items = FilesBrowserTrash.tombstoned(entries);

    if (!items.length) return;
    const warning = all ? 'Permanently delete every eligible item? Retention, record locks, changed tombstones, and unapproved disposal will remain.' : `Permanently delete ${ items.length } eligible item${ items.length === 1 ? '' : 's' }? Protected or changed items will remain.`;

    if (!window.confirm(warning)) return;
    await this.browser.refresher.runMutation(async() => {
      let completed = 0; let notAttempted = 0; let pending = FilesBrowserTrash.foldersFirst(items); const recovering:string[] = []; const failures:string[] = [];

      while (pending.length) {
        const entry = pending.shift()!;

        try {
          const result = await purge(entry.trashItem);

          if (result.status === 'purged') completed++;
          else {
            const chunks = 'chunks' in result ? ` chunks ${ result.chunks };` : '';

            recovering.push(`${ entry.name }: ${ result.reason || `metadata removed;${ chunks } retained artifacts ${ result.retainedArtifacts }` }`);
          }
        } catch (cause) {
          failures.push(`${ entry.name }: ${ FilesBrowserState.messageOf(cause) }`);
          if (entry.trashItem.kind === 'folder') { notAttempted = pending.length; break }
          continue;
        }
        if (entry.trashItem.kind === 'folder' && pending.length) {
          try { pending = await this.authoritativeTrashEntries(pending) } catch (cause) { failures.push(`Trash refresh: ${ FilesBrowserState.messageOf(cause) }`); notAttempted = pending.length; break }
        }
      }
      state.operationNotice.value = completed ? `${ completed } item${ completed === 1 ? '' : 's' } fully disposed.` : '';
      state.operationError.value = [recovering.length ? `${ recovering.length } item${ recovering.length === 1 ? '' : 's' } require cleanup recovery: ${ recovering.join(' · ') }` : '', failures.length ? `${ failures.length } item${ failures.length === 1 ? '' : 's' } retained: ${ failures.join(' · ') }` : '', notAttempted ? `${ notAttempted } remaining item${ notAttempted === 1 ? ' was' : 's were' } retained without an attempt.` : ''].filter(Boolean).join(' ');
      state.selectedKeys.value = new Set();
    });
  }

  /** After a folder settles, only the items still in the service's Trash are attempted. */
  private async authoritativeTrashEntries(pending:TrashDisplayEntry[]):Promise<TrashDisplayEntry[]> {
    const state = this.browser.state;
    const loaded = await state.props.dataSource.load();
    const authoritative = new Map((loaded.trash ?? []).map(item => [`${ item.kind }:${ item.id }`, item]));

    state.snapshot.value = loaded;
    return pending.filter(entry => authoritative.has(`${ entry.trashItem.kind }:${ entry.trashItem.id }`));
  }

  readonly purgeSelected = ():Promise<void> => this.purgeEntries(this.browser.selection.selectedEntries.value);

  readonly emptyTrash = ():Promise<void> => this.purgeEntries(this.browser.location.trashItems.value.map(this.browser.factory.toTrashDisplay), true);
}
