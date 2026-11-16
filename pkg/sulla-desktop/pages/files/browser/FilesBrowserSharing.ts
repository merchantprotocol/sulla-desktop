// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesBrowserController } from './FilesBrowserController';
import type { DisplayEntry } from './FilesBrowserTypes';

/** Opens the Share sheet for a file (public link) or the open folder (organization members). */
export class FilesBrowserSharing {
  constructor(private readonly browser:FilesBrowserController) {}

  readonly shareEntry = (entry:DisplayEntry | null):void => {
    const state = this.browser.state; const snapshot = state.snapshot.value;

    if (state.busy.value || !entry || entry.folder || !state.props.dataSource.createPublicLink || !snapshot) return;
    const capture = /(^|\/)(screenshots?|recordings?|captures?)(\/|$)/i.test(entry.path);

    state.shareTarget.value = { id: entry.id, name: entry.name, folder: false, path: entry.path, collectionId: snapshot.collection.id, orgId: snapshot.collection.orgId, ownerUserId: snapshot.collection.ownerUserId, assetKind: entry.agent ? 'artifact' : capture ? 'capture' : 'file' };
  };

  readonly shareSelectedFile = ():void => { this.shareEntry(this.browser.selection.selectedFileForShare.value ?? null) };

  readonly shareCurrentFolder = ():void => {
    const state = this.browser.state; const source = state.props.dataSource;

    if (state.busy.value || !state.snapshot.value) return;
    if (!state.snapshot.value.collection.orgId || !source.shareFolder || !source.listMembers || !source.capabilities.orgSharing) { state.operationError.value = 'Folder sharing needs an organization collection you manage.'; return }
    if (!state.currentPath.value) { state.operationError.value = 'Open a folder to share it. The top of a collection is shared through its members.'; return }
    state.shareTarget.value = { id: `folder:${ state.currentPath.value }`, name: state.currentPath.value.split('/').at(-1) || 'My Files', folder: true, path: state.currentPath.value, collectionId: state.snapshot.value.collection.id, orgId: state.snapshot.value.collection.orgId, ownerUserId: state.snapshot.value.collection.ownerUserId };
  };

  readonly canShareEntry = (entry:DisplayEntry):boolean => { const state = this.browser.state; const source = state.props.dataSource; return entry.folder ? Boolean(state.snapshot.value?.collection.orgId && source.capabilities.orgSharing && source.shareFolder && source.listMembers) : source.capabilities.publicLinks };

  readonly closeShare = ():void => { this.browser.state.shareTarget.value = null };
}
