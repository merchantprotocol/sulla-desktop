// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesBrowserCreation } from './FilesBrowserCreation';
import { FilesBrowserDialogs } from './FilesBrowserDialogs';
import { FilesBrowserDragDrop } from './FilesBrowserDragDrop';
import { FilesBrowserDropZones } from './FilesBrowserDropZones';
import { FilesBrowserFileOperations } from './FilesBrowserFileOperations';
import { FilesBrowserFolderLoader } from './FilesBrowserFolderLoader';
import { FilesBrowserGestures } from './FilesBrowserGestures';
import { FilesBrowserIcons } from './FilesBrowserIcons';
import { FilesBrowserItemActions } from './FilesBrowserItemActions';
import { FilesBrowserKeyboard } from './FilesBrowserKeyboard';
import { FilesBrowserLifecycle } from './FilesBrowserLifecycle';
import { FilesBrowserListing } from './FilesBrowserListing';
import { FilesBrowserLiveUpdates } from './FilesBrowserLiveUpdates';
import { FilesBrowserLocation } from './FilesBrowserLocation';
import { FilesBrowserMenus } from './FilesBrowserMenus';
import { FilesBrowserNavigation } from './FilesBrowserNavigation';
import { FilesBrowserQuickLook } from './FilesBrowserQuickLook';
import { FilesBrowserReceipts } from './FilesBrowserReceipts';
import { FilesBrowserRefresher } from './FilesBrowserRefresher';
import { FilesBrowserRename } from './FilesBrowserRename';
import { FilesBrowserSearch } from './FilesBrowserSearch';
import { FilesBrowserSelection } from './FilesBrowserSelection';
import { FilesBrowserSharing } from './FilesBrowserSharing';
import { FilesBrowserSidebarModel } from './FilesBrowserSidebarModel';
import { FilesBrowserState } from './FilesBrowserState';
import { FilesBrowserTargetActions } from './FilesBrowserTargetActions';
import { FilesBrowserTrash } from './FilesBrowserTrash';
import { FilesBrowserUploads } from './FilesBrowserUploads';
import { FilesBrowserViewPreferences } from './FilesBrowserViewPreferences';
import { FilesBrowserVirtualScroll } from './FilesBrowserVirtualScroll';
import { FilesDragSnapshots } from './FilesDragSnapshots';
import { FilesEntryFactory } from './FilesEntryFactory';
import { FilesEntryFormatter } from './FilesEntryFormatter';
import { FilesEntryPresenter } from './FilesEntryPresenter';

import type { FilesBrowserEmit, FilesBrowserProps, FilesExplorer, FilesOperations } from './FilesBrowserTypes';
import type { InjectionKey } from 'vue';

/**
 * One Files browser screen. Owns every region object of a single FilesBrowser.vue instance and is the
 * mediator they reach each other through; FilesBrowser.vue and its child components only render it.
 * Construct it during component setup (computeds and watchers belong to that component's scope).
 */
export class FilesBrowserController {
  static readonly injectionKey:InjectionKey<FilesBrowserController> = Symbol('files-browser');

  readonly icons = FilesBrowserIcons;
  readonly state:FilesBrowserState;
  readonly format = new FilesEntryFormatter();
  readonly presenter:FilesEntryPresenter;
  readonly factory:FilesEntryFactory;
  readonly location:FilesBrowserLocation;
  readonly sidebar:FilesBrowserSidebarModel;
  readonly preferences:FilesBrowserViewPreferences;
  readonly listing:FilesBrowserListing;
  readonly virtualScroll:FilesBrowserVirtualScroll;
  readonly selection:FilesBrowserSelection;
  readonly refresher:FilesBrowserRefresher;
  readonly liveUpdates:FilesBrowserLiveUpdates;
  readonly search:FilesBrowserSearch;
  readonly folderLoader:FilesBrowserFolderLoader;
  readonly navigation:FilesBrowserNavigation;
  readonly dragSnapshots:FilesDragSnapshots;
  readonly dragDrop:FilesBrowserDragDrop;
  readonly dropZones:FilesBrowserDropZones;
  readonly fileOperations:FilesBrowserFileOperations;
  readonly receipts:FilesBrowserReceipts;
  readonly trash:FilesBrowserTrash;
  readonly rename:FilesBrowserRename;
  readonly creation:FilesBrowserCreation;
  readonly menus:FilesBrowserMenus;
  readonly targetActions:FilesBrowserTargetActions;
  readonly quickLook:FilesBrowserQuickLook;
  readonly gestures:FilesBrowserGestures;
  readonly keyboard:FilesBrowserKeyboard;
  readonly dialogs:FilesBrowserDialogs;
  readonly sharing:FilesBrowserSharing;
  readonly itemActions:FilesBrowserItemActions;
  readonly uploads:FilesBrowserUploads;
  readonly lifecycle:FilesBrowserLifecycle;

  constructor(props:FilesBrowserProps, emit:FilesBrowserEmit, readonly explorer:FilesExplorer, readonly operations:FilesOperations) {
    this.state = new FilesBrowserState(props, emit);
    this.presenter = new FilesEntryPresenter(this.state, this.format);
    this.factory = new FilesEntryFactory(this.format, this.presenter);
    this.location = new FilesBrowserLocation(this.state);
    this.sidebar = new FilesBrowserSidebarModel(this.state, this.location, this.presenter, this.format);
    this.preferences = new FilesBrowserViewPreferences(this.state, explorer);
    this.listing = new FilesBrowserListing(this.state, this.location, this.preferences, this.factory, this.presenter, this.format);
    this.virtualScroll = new FilesBrowserVirtualScroll(this);
    this.selection = new FilesBrowserSelection(this);
    this.refresher = new FilesBrowserRefresher(this);
    this.liveUpdates = new FilesBrowserLiveUpdates(this);
    this.search = new FilesBrowserSearch(this);
    this.folderLoader = new FilesBrowserFolderLoader(this);
    this.navigation = new FilesBrowserNavigation(this);
    this.dragSnapshots = new FilesDragSnapshots(this);
    this.dragDrop = new FilesBrowserDragDrop(this);
    this.dropZones = new FilesBrowserDropZones(this);
    this.fileOperations = new FilesBrowserFileOperations(this);
    this.receipts = new FilesBrowserReceipts(this);
    this.trash = new FilesBrowserTrash(this);
    this.rename = new FilesBrowserRename(this);
    this.creation = new FilesBrowserCreation(this);
    this.menus = new FilesBrowserMenus(this);
    this.targetActions = new FilesBrowserTargetActions(this);
    this.quickLook = new FilesBrowserQuickLook(this);
    this.gestures = new FilesBrowserGestures(this);
    this.keyboard = new FilesBrowserKeyboard(this);
    this.dialogs = new FilesBrowserDialogs(this);
    this.sharing = new FilesBrowserSharing(this);
    this.itemActions = new FilesBrowserItemActions(this);
    this.uploads = new FilesBrowserUploads();
    this.lifecycle = new FilesBrowserLifecycle(this);
  }

  /** The live props (reactive): always read `dataSource` through here, never cache it. */
  get props():FilesBrowserProps { return this.state.props }
}
