// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { rejectSettingsBypass } from './settingsGuard';

/**
 * Redis Set Tool - Worker class for execution
 */
export class RedisSetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, value, ttl } = input;

    const blocked = rejectSettingsBypass(key, undefined, 'set');

    if (blocked) return blocked;

    try {
      await redisClient.set(key, value, ttl);

      return {
        successBoolean: true,
        responseString: `Redis SET ${ key } = "${ value }"${ ttl ? ` (TTL: ${ ttl }s)` : '' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error setting Redis key: ${ (error as Error).message }`,
      };
    }
  }
}
