// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesTool } from './common';

import type { ToolResponse } from '../base';
import { addChatLinks } from './chatLink';

export class FilesWhereWorker extends FilesTool {
  name = '';
  description = '';

  protected async _validatedCall(input:any):Promise<ToolResponse> {
    const query = new URLSearchParams({ what:String(input.what), ...(input.kind ? {kind:String(input.kind)} : {}), ...(input.project ? {project:String(input.project)} : {}) });
    const result = await this.containerJson(`/v1/folders/where?${query}`, input);

    return { successBoolean:true, responseString:JSON.stringify(addChatLinks(result)) };
  }
}
