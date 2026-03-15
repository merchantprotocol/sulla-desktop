import { BaseTool, ToolResponse } from '../base';
import { redisClient } from '../../database/RedisClient';

/**
 * Redis Set Tool - Worker class for execution
 */
export class RedisSetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, value, ttl } = input;

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
