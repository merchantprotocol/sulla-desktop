// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, type ToolResponse } from '../base';

import { getStorageCleanupService, type StorageCleanupService } from '@pkg/main/storageCleanup/StorageCleanupService';
import { openPreferences } from '@pkg/window';

type CleanupPreviewService = Pick<StorageCleanupService, 'inventory' | 'preparePreview'>;

export class StorageCleanupPreviewWorker extends BaseTool {
  name = '';
  description = '';

  constructor(
    private readonly cleanup:CleanupPreviewService = getStorageCleanupService(),
    private readonly openFiles:() => void = () => openPreferences('files'),
  ) {
    super();
  }

  protected async _validatedCall(input:Record<string, unknown>):Promise<ToolResponse> {
    const targetIds = Array.isArray(input.target_ids)
      ? input.target_ids.filter((value):value is string => typeof value === 'string')
      : [];
    const inventory = await this.cleanup.inventory();
    const plan = targetIds.length ? await this.cleanup.preparePreview({ targetIds }) : undefined;
    if (input.open !== false) this.openFiles();
    return {
      successBoolean: true,
      responseString: plan
        ? `Prepared review ${ plan.id } for ${ plan.targets.length } workspace(s). The human must review and confirm in Preferences > Files.`
        : `Found ${ inventory.targets.length } code workspace(s); ${ inventory.targets.filter(item => item.selectable).length } are currently selectable. Opened Preferences > Files for human review.`,
      result: { inventory, plan },
    };
  }
}
