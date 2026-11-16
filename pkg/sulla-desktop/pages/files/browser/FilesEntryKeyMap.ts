// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** What a key press on a focused row does. `quick-look-keys` forwards the press to the open Quick Look. */
export type FilesEntryKeyAction =
  | 'ignore-repeat' | 'undo' | 'activate' | 'open-parent' | 'quick-look-keys' | 'next' | 'previous' | 'quick-look'
  | 'rename' | 'select-all' | 'copy' | 'cut' | 'paste' | 'trash' | 'clear-selection' | 'menu';

/** The key fields the map reads; a KeyboardEvent satisfies it. */
export interface FilesKeyPress { key:string; metaKey:boolean; ctrlKey:boolean; shiftKey:boolean; repeat:boolean }

export interface FilesEntryKeyContext { isMac:boolean; quickLookOpen:boolean; canPaste:boolean; inTrash:boolean }

/**
 * The keyboard shortcuts of a focused row (Finder on macOS, Explorer elsewhere), first match wins, in the exact
 * order the browser has always checked them. Every action except `quick-look-keys` prevents the default.
 */
export class FilesEntryKeyMap {
  static resolve(event:FilesKeyPress, context:FilesEntryKeyContext):FilesEntryKeyAction | null {
    const { isMac } = context; const modifier = event.metaKey || event.ctrlKey; const key = event.key; const lower = key.toLowerCase();

    if (event.repeat && (key === 'Delete' || key === 'Backspace')) return 'ignore-repeat';
    if (modifier && lower === 'z' && !event.shiftKey) return 'undo';
    if (isMac && event.metaKey && key === 'ArrowDown') return 'activate';
    if (modifier && key === 'ArrowUp') return 'open-parent';
    if (context.quickLookOpen) return 'quick-look-keys';
    if (key === 'ArrowDown' || key === 'ArrowRight') return 'next';
    if (key === 'ArrowUp' || key === 'ArrowLeft') return 'previous';
    if (key === ' ' && !event.metaKey && !event.ctrlKey) return 'quick-look';
    if ((isMac && key === 'Enter') || (!isMac && key === 'F2')) return 'rename';
    if (!isMac && key === 'Enter') return 'activate';
    if (modifier && lower === 'a') return 'select-all';
    if (modifier && lower === 'c') return 'copy';
    if (modifier && lower === 'x') return 'cut';
    if (modifier && lower === 'v' && context.canPaste) return 'paste';
    if ((key === 'Delete' || (event.metaKey && key === 'Backspace')) && !context.inTrash) return 'trash';
    if (key === 'Escape') return 'clear-selection';
    if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) return 'menu';
    return null;
  }
}
