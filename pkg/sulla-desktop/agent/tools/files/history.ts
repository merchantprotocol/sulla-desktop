// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';
import type { ToolResponse } from '../base';
export class FilesHistoryWorker extends FilesTool {
  name = ''; description = '';
  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const resolved = await this.resolvePath(input);
    const fileId = resolved?.fileId ?? input.file_id;
    if (!fileId) throw new Error('path resolving to a file or file_id is required');
    return { successBoolean: true, responseString: JSON.stringify(await this.containerJson(`/v1/files/${ encodeURIComponent(fileId) }/history`, input)) };
  }
}
