// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { rejectSettingsBypass } from './settingsGuard';

/**
 * Redis Hset Tool - Worker class for execution
 */
export class RedisHsetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, field, value } = input;

    const blocked = rejectSettingsBypass(key, field, 'hset');

    if (blocked) return blocked;

    try {
      const count = await redisClient.hset(key, field, value);

      return {
        successBoolean: true,
        responseString: `Redis HSET ${ key } ${ field } = "${ value }" (${ count === 1 ? 'new field' : 'existing field updated' })`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error setting Redis hash field: ${ (error as Error).message }`,
      };
    }
  }
}
