import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { rejectSettingsBypass } from './settingsGuard';

/**
 * Redis Rpush Tool - Worker class for execution
 */
export class RedisRpushWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, values } = input;

    const blocked = rejectSettingsBypass(key, undefined, 'rpush');

    if (blocked) return blocked;

    try {
      const length = await redisClient.rpush(key, ...values);

      return {
        successBoolean: true,
        responseString: `Redis RPUSH ${ key }: appended ${ values.length } values, new length is ${ length }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error appending to Redis list: ${ (error as Error).message }`,
      };
    }
  }
}
