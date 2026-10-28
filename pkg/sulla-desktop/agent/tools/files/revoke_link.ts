// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';

import { isCloudSignedIn } from '@pkg/main/cloud/cloudFetch';

import type { ToolResponse } from '../base';

export class FilesRevokeLinkWorker extends FilesTool {
  name = '';
  description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    if (!await isCloudSignedIn()) return { successBoolean: false, responseString: 'Sign in to Sulla Cloud before revoking a public link.' };
    try { await this.containerRequest(`/v1/links/${ encodeURIComponent(input.id) }`, input, { method: 'DELETE' }); return { successBoolean: true, responseString: 'Share link revoked.' } } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) } }
  }
}
