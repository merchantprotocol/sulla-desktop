// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import type { ToolResponse } from '../base';
import { FilesListingPager } from '@pkg/agent/files/FilesListingPager';

/** Single source for the unknown-collection guidance, shared by list_shared and share_to_org. */
export const NO_ORG_COLLECTION_MESSAGE = 'No organization collection found. Use files/list_shared to see the collections you can use. Org collections are created by an org owner or admin.';

/** Lists only grant-visible organization collections, optionally listing one collection's files. */
export class FilesListSharedWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const collections = await this.containerJson<any[]>('/v1/collections', input);
    const organizations = collections.filter(collection => collection.workspaceScope === 'organization' && (!input.orgId || collection.orgId === input.orgId));
    if (input.collectionId) {
      const collection = organizations.find(item => item.id === input.collectionId);
      if (!collection) throw new Error(NO_ORG_COLLECTION_MESSAGE);
      const files: any[] = [];
      for await (const page of FilesListingPager.pages<any>(url => this.containerRequest(url, input), '/v1/files', { collectionId: collection.id, path: input.folder ?? '' })) files.push(...page);
      return { successBoolean: true, responseString: JSON.stringify(files.map(file => ({ path: file.path, size: file.size, updatedAt: file.updated_at ?? file.updatedAt, createdBy: file.version_created_by_id ?? file.created_by_id }))) };
    }
    return { successBoolean: true, responseString: JSON.stringify(organizations.map(collection => ({ collectionId: collection.id, orgId: collection.orgId, orgName: collection.orgName, name: collection.name, level: collection.level ?? collection.access_role, path: collection.explorer_path ? `/mnt/sulla-files/${collection.explorer_path}` : `/mnt/sulla-files/Organizations/${collection.orgName}/${collection.name}` }))) };
  }
}
