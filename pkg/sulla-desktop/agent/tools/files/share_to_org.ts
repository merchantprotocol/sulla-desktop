// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import type { ToolResponse } from '../base';

/** Copies a source file's current content through Files API into an existing editable org collection. */
export class FilesShareToOrgWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (input.overwrite === true) throw new Error('overwrite is not supported; choose a new name');
    const collections = await this.containerJson<any[]>('/v1/collections', input);
    const collection = collections.find(item => item.workspaceScope === 'organization' && (
      input.collectionId ? item.id === input.collectionId : item.orgName === input.orgName && item.name === input.collectionName
    ));
    if (!collection) throw new Error('No organization collection found; use files/list_shared. Collections must be created by an org admin in the UI.');
    const level = collection.level ?? collection.access_role;
    if (level === 'view') throw new Error(`You can view ${collection.name} but not add files to it; ask an org admin for edit`);
    if (!['edit', 'manage', 'owner', 'admin'].includes(level)) throw new Error(`You do not have edit access to ${collection.name}`);
    const resolved = input.file_id ? undefined : await this.resolvePath({ path: input.source });
    const fileId = input.file_id ?? resolved?.fileId;
    if (!fileId) throw new Error('source must resolve to a Files file or file_id');
    const detail = await this.containerJson<any>(`/v1/files/${encodeURIComponent(fileId)}`, input);
    const response = await this.containerRequest(`/v1/files/${encodeURIComponent(fileId)}/download`, input);
    if (!response.ok) throw new Error(`Unable to read source file (${response.status})`);
    const content = await response.arrayBuffer();
    const sourcePath = String(detail.path ?? input.source ?? fileId).replaceAll('\\', '/');
    const fileName = input.name ?? sourcePath.split('/').filter(Boolean).at(-1);
    if (!fileName) throw new Error('Could not determine source file name');
    const path = [input.folder, fileName].filter(Boolean).join('/');
    const upload = await this.containerRequest(`/v1/files/import?collectionId=${encodeURIComponent(collection.id)}&path=${encodeURIComponent(path)}`, input, { method: 'PUT', headers: { 'content-type': detail.mime ?? 'application/octet-stream', 'x-sulla-expected-bytes': String(content.byteLength) }, body: content });
    if (!upload.ok) throw new Error(`Unable to copy file into organization collection (${upload.status})`);
    const result = await upload.json() as any;
    return { successBoolean: true, responseString: JSON.stringify({ collectionId: collection.id, path: result.path, versionId: result.versionId ?? result.current_version_id }) };
  }
}
