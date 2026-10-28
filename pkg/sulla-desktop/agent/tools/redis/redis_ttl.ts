// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { rejectSettingsBypass } from './settingsGuard';

/**
 * Redis Ttl Tool - Worker class for execution
 */
export class RedisTtlWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    const blocked = rejectSettingsBypass(key, undefined, 'ttl');

    if (blocked) return blocked;

    try {
      const seconds = await redisClient.ttl(key);

      return {
        successBoolean: true,
        responseString: `Redis TTL for ${ key }: ${ seconds === -2 ? 'Key does not exist' : seconds === -1 ? 'No expiration' : `${ seconds } seconds` }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting Redis key TTL: ${ (error as Error).message }`,
      };
    }
  }
}
