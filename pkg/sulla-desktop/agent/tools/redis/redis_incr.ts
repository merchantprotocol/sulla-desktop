// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { rejectSettingsBypass } from './settingsGuard';

/**
 * Redis Incr Tool - Worker class for execution
 */
export class RedisIncrWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    const blocked = rejectSettingsBypass(key, undefined, 'incr');

    if (blocked) return blocked;

    try {
      const newValue = await redisClient.incr(key);

      return {
        successBoolean: true,
        responseString: `Redis INCR ${ key }: new value is ${ newValue }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error incrementing Redis key: ${ (error as Error).message }`,
      };
    }
  }
}
