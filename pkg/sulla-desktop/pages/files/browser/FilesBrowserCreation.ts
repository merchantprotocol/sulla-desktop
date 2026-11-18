// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nextTick, ref } from 'vue';

import { supportsDocumentEditor } from '../editor/editorTypes';
import { FilesDropTargets } from './FilesDropTargets';
import { FilesNameRules } from './FilesNameRules';

import type { FilesBrowserController } from './FilesBrowserController';
import type { FilesMenuPoint, FilesNamePrompt } from './FilesBrowserTypes';

/** The New menu, the name dialog and creating folders and files in the open (or a given) folder. */
export class FilesBrowserCreation {
  static readonly newFileKinds:readonly { label:string; name:string }[] = [
    { label: 'Sulla Document', name: 'Untitled.sulla' },
    { label: 'Markdown file', name: 'Untitled.md' },
    { label: 'Text file', name: 'Untitled.txt' },
    { label: 'Spreadsheet (CSV)', name: 'Untitled.csv' },
    { label: 'Other file…', name: 'untitled' },
  ];

  /** Electron has no window.prompt (it returns null at once), so names are asked for in this dialog. */
  readonly namePrompt = ref<FilesNamePrompt | null>(null);
  readonly nameDialog = ref<HTMLDialogElement | null>(null);
  readonly nameInput = ref<HTMLInputElement | null>(null);
  readonly newMenu = ref<FilesMenuPoint | null>(null);
  readonly newMenuButton = ref<HTMLButtonElement | null>(null);
  readonly newActionMenu = ref<HTMLElement | null>(null);

  constructor(private readonly browser:FilesBrowserController) {}

  readonly askName = async(title:string, label:string, confirm:string, value = '', allowEmpty = false):Promise<string | null> => {
    this.namePrompt.value?.resolve(null);
    const answer = new Promise<string | null>(resolve => { this.namePrompt.value = { title, label, confirm, value, allowEmpty, resolve } });

    await nextTick(); this.nameDialog.value?.showModal();
    const input = this.nameInput.value;

    if (input) { input.focus(); input.setSelectionRange(0, FilesNameRules.promptSelectionEnd(input.value)) }
    return answer;
  };

  readonly settleNamePrompt = (value:string | null):void => { const prompt = this.namePrompt.value; if (!prompt) return; this.namePrompt.value = null; this.nameDialog.value?.close(); prompt.resolve(value === null ? null : value.trim() || (prompt.allowEmpty ? '' : null)) };

  /** A click on the dialog backdrop (outside its box) cancels. */
  readonly onNameBackdrop = (event:MouseEvent):void => { const dialog = this.nameDialog.value; if (!dialog || event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.settleNamePrompt(null) };

  readonly newFolder = async(folder = this.browser.state.currentPath.value):Promise<void> => {
    const state = this.browser.state; const operations = this.browser.operations;

    if (this.browser.location.readOnlyArea.value) return;
    if (state.busy.value || state.loading.value || state.section.value !== 'files' || (!state.props.dataSource.capabilities.upload && !operations.supported())) return;
    const name = await this.askName('New folder', `Inside ${ folder || 'My Files' }`, 'Create', 'untitled folder'); if (!name) return;

    if (!FilesNameRules.isSingleSegment(name)) { state.operationError.value = FilesNameRules.FOLDER_INVALID; return }
    const path = FilesDropTargets.joinPath(folder, name);

    if (operations.supported()) await this.browser.fileOperations.submitReceiptItems([{ itemId: crypto.randomUUID(), action: 'create-folder', targetPath: path }]);
    else await this.browser.refresher.runMutation(() => state.props.dataSource.createFolder(path));
  };

  readonly newFile = async(folder = this.browser.state.currentPath.value, suggested = 'Untitled.txt'):Promise<void> => {
    const state = this.browser.state;

    if (this.browser.location.readOnlyArea.value) return;
    if (state.busy.value || state.loading.value || state.section.value !== 'files' || !state.props.dataSource.createFile) return;
    const name = await this.askName('New file', `Inside ${ folder || 'My Files' }`, 'Create', suggested); if (!name) return;

    if (!FilesNameRules.isSingleSegment(name)) { state.operationError.value = FilesNameRules.FILE_INVALID; return }
    const path = FilesDropTargets.joinPath(folder, name);
    const created = await this.browser.refresher.runMutation(() => state.props.dataSource.createFile!(path));
    // Like Google Drive: a new document opens straight into the editor.
    const file = created && supportsDocumentEditor(path) ? this.browser.location.activeFiles.value.find(item => item.path === path) : undefined;

    if (file) state.emit('open-editor', file, state.snapshot.value?.collection.id, 'editing');
  };

  readonly toggleNewMenu = async():Promise<void> => {
    if (this.newMenu.value) { this.closeNewMenu(); return }
    this.browser.menus.closeActions(false); this.browser.menus.closeBackgroundActions();
    const rect = this.newMenuButton.value?.getBoundingClientRect(); if (!rect) return;

    this.newMenu.value = { x: rect.left, y: rect.bottom + 4 };
    await nextTick(); this.newActionMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };

  readonly closeNewMenu = ():void => { this.newMenu.value = null };

  readonly upload = async():Promise<void> => { const state = this.browser.state; if (!state.props.dataSource.capabilities.upload || state.section.value !== 'files') return; const destination = state.currentPath.value; await this.browser.refresher.runMutation(async() => { await state.props.dataSource.chooseUpload(destination) }) };

  readonly chooseNativeSource = async():Promise<void> => { const source = this.browser.state.props.dataSource; if (source.chooseNativeSource) await this.browser.refresher.runMutation(async() => { await source.chooseNativeSource!() }) };
}
