// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nextTick, ref } from 'vue';

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry, FilesMenuPoint } from './FilesBrowserTypes';
import { FilesOpenDestinationRouter } from '../FilesOpenDestinationRouter';

/** The row action menu and the folder-background menu: placement, focus, keyboard and dismissal. */
export class FilesBrowserMenus {
  readonly actionMenu = ref<HTMLElement | null>(null);
  readonly menuPosition = ref<FilesMenuPoint>({ x: 0, y: 0 });
  readonly actionTarget = ref<DisplayEntry | null>(null);
  readonly recentApplications = ref<string[]>([]);
  readonly backgroundActionMenu = ref<HTMLElement | null>(null);
  readonly backgroundMenu = ref<FilesMenuPoint | null>(null);
  private menuTrigger:HTMLElement | null = null;

  constructor(private readonly browser:FilesBrowserController, private readonly openDestinationRouter = new FilesOpenDestinationRouter()) {}

  readonly closeActions = (restoreFocus = true):void => { this.actionTarget.value = null; if (restoreFocus) this.menuTrigger?.focus() };

  readonly openActions = async(entry:DisplayEntry, event:MouseEvent | KeyboardEvent):Promise<void> => {
    const state = this.browser.state;

    if (entry.rootCollectionId) return;

    this.closeBackgroundActions();
    if (!state.selectedKeys.value.has(entry.key)) state.selectedKeys.value = new Set([entry.key]);
    this.menuTrigger = event.currentTarget as HTMLElement; const rect = this.menuTrigger.getBoundingClientRect();
    this.menuPosition.value = event instanceof MouseEvent && event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom };
    this.actionTarget.value = entry; this.recentApplications.value = !entry.folder && state.props.dataSource.recentAppsForFile ? await state.props.dataSource.recentAppsForFile(entry.name).catch(() => []) : []; await nextTick(); const menu = this.actionMenu.value; if (!menu) return;
    const bounds = menu.getBoundingClientRect();

    this.menuPosition.value = { x: Math.max(4, Math.min(this.menuPosition.value.x, window.innerWidth - bounds.width - 4)), y: Math.max(4, Math.min(this.menuPosition.value.y, window.innerHeight - bounds.height - 4)) };
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };

  /** Window pointerdown: a press outside an open menu closes it. */
  readonly dismissActions = (event:PointerEvent):void => {
    const creation = this.browser.creation;

    if (creation.newMenu.value && !creation.newActionMenu.value?.contains(event.target as Node) && !creation.newMenuButton.value?.contains(event.target as Node)) creation.closeNewMenu();
    if (this.actionTarget.value && !this.actionMenu.value?.contains(event.target as Node)) this.closeActions(false);
    if (this.backgroundMenu.value && !this.backgroundActionMenu.value?.contains(event.target as Node)) this.closeBackgroundActions();
  };

  readonly onMenuKeydown = (event:KeyboardEvent):void => {
    const creation = this.browser.creation;

    event.stopPropagation();
    const menu = event.currentTarget as HTMLElement;

    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); if (menu === this.actionMenu.value) this.closeActions(); else if (menu === creation.newActionMenu.value) { creation.closeNewMenu(); creation.newMenuButton.value?.focus() } else { this.closeBackgroundActions(); this.browser.state.mainSurface.value?.focus() } return }
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next].focus() }
  };

  readonly closeBackgroundActions = ():void => { this.backgroundMenu.value = null };

  readonly openBackgroundActions = async(event:MouseEvent):Promise<void> => { this.browser.selection.clearSelection(); this.closeActions(false); this.backgroundMenu.value = { x: event.clientX, y: event.clientY }; await nextTick(); const menu = this.backgroundActionMenu.value; if (!menu || !this.backgroundMenu.value) return; const rect = menu.getBoundingClientRect(); this.backgroundMenu.value = { x: Math.max(4, Math.min(this.backgroundMenu.value.x, window.innerWidth - rect.width - 4)), y: Math.max(4, Math.min(this.backgroundMenu.value.y, window.innerHeight - rect.height - 4)) }; menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() };

  /** Right-click on empty content (not a row or control) opens the folder menu. */
  readonly onSurfaceContextMenu = (event:MouseEvent):void => { if ((event.target as HTMLElement).closest('[data-entry-key],button,input,select,a,[role="menu"]')) return; event.preventDefault(); void this.openBackgroundActions(event) };

  /** Window resize closes every menu and ends any pointer gesture. */
  readonly closeMenuOnResize = ():void => { this.browser.creation.closeNewMenu(); this.closeActions(false); this.closeBackgroundActions(); this.browser.gestures.stopPointerGesture?.() };

  readonly openWithApplication = async(application?:string):Promise<void> => {
    const state = this.browser.state; const target = this.actionTarget.value;
    if (!target || target.folder) return;
    this.closeActions();
    if (this.openDestinationRouter.isHtmlPath(target.path)) { this.browser.navigation.openInSulla(target); return }
    if (!state.props.dataSource.openFileWithApp) return;
    await this.browser.refresher.runMutation(async() => { const result = await state.props.dataSource.openFileWithApp!(target.id, target.currentVersionId, application); this.recentApplications.value = result.recentApplications }, false);
  };
}
