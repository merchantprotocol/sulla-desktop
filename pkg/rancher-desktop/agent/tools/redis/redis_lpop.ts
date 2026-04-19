import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Redis Lpop Tool - Worker class for execution
 */
export class RedisLpopWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

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
