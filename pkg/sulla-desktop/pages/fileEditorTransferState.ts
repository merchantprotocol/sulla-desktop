// SPDX-License-Identifier: GPL-2.0-or-later

export interface FileEditorSnapshot {
  filePath: string;
  text: string;
  dirty: boolean;
}

/** Validates a transferred editor snapshot before it can supersede disk contents. */
export class FileEditorTransferState {
  static restore(filePath: string, snapshot: Partial<FileEditorSnapshot> | undefined): FileEditorSnapshot | null {
    if (!snapshot || snapshot.filePath !== filePath || typeof snapshot.text !== 'string') return null;
    return { filePath, text: snapshot.text, dirty: !!snapshot.dirty };
  }
}
