// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { FilesTool } from './common';
import type { ToolResponse } from '../base';

/** Create an encrypted org shared collection through the Desktop main-process runtime. */
export class FilesCreateOrgCollectionWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const orgId = typeof input.orgId === 'string' ? input.orgId.trim() : '';
    const orgName = typeof input.orgName === 'string' ? input.orgName.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return { successBoolean: false, responseString: 'name is required.' };
    if (!orgId && !orgName) return { successBoolean: false, responseString: 'orgId or orgName is required.' };
    try {
      const { OrgFilesDesktopRuntime } = await import('@pkg/main/cloud/orgFiles/OrgFilesDesktopRuntime');
      const result = await OrgFilesDesktopRuntime.current().createCollection({ orgId: orgId || undefined, orgName: orgName || undefined, name });
      return { successBoolean: true, responseString: JSON.stringify(result) };
    } catch (error) {
      return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) };
    }
  }
}
