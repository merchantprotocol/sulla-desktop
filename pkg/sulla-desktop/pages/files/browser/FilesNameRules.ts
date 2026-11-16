// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The outcome of committing an inline rename. */
export type FilesRenameDecision = { kind:'cancel' } | { kind:'invalid'; message:string } | { kind:'rename'; name:string };

/** Name rules for create and rename: one path segment, never "." or "..", and which part is pre-selected. */
export class FilesNameRules {
  static readonly RENAME_INVALID = 'Names can’t contain “/” or be “.” or “..”.';
  static readonly FOLDER_INVALID = 'Enter a folder name without path separators.';
  static readonly FILE_INVALID = 'Enter a file name without path separators.';

  /** True when the name is a single path segment Files can store. */
  static isSingleSegment(name:string):boolean { return !(name.includes('/') || name === '.' || name === '..') }

  /** Inline rename: an empty or unchanged name cancels; an invalid one keeps editing with a message. */
  static decideRename(currentName:string, input:string):FilesRenameDecision {
    const name = input.trim();

    if (!name || name === currentName) return { kind: 'cancel' };
    if (!FilesNameRules.isSingleSegment(name)) return { kind: 'invalid', message: FilesNameRules.RENAME_INVALID };
    return { kind: 'rename', name };
  }

  /** Where the pre-selection of an inline rename ends: before the extension for files, the whole name for folders. */
  static renameSelectionEnd(name:string, folder:boolean):number {
    const dot = folder ? -1 : name.lastIndexOf('.');

    return dot > 0 ? dot : name.length;
  }

  /** Where the pre-selection in the name dialog ends: before ".sulla.md" or the last extension, else the whole value. */
  static promptSelectionEnd(value:string):number {
    const dot = value.endsWith('.sulla.md') ? value.length - 9 : value.lastIndexOf('.');

    return dot > 0 ? dot : value.length;
  }
}
