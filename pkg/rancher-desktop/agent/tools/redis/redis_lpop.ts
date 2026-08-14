import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { rejectSettingsBypass } from './settingsGuard';

/**
 * Redis Lpop Tool - Worker class for execution
 */
export class RedisLpopWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    const blocked = rejectSettingsBypass(key, undefined, 'lpop');

    if (blocked) return blocked;

    try {
      const value = await redisClient.lpop(key);

      return {
        successBoolean: true,
        responseString: `Redis LPOP ${ key }: ${ value || '(nil)' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error popping from Redis list: ${ (error as Error).message }`,
      };
    }
  }
}
