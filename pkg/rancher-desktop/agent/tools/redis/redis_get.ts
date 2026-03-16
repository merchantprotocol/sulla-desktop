import { BaseTool, ToolResponse } from '../base';
import { redisClient } from '../../database/RedisClient';

/**
 * Redis Get Tool - Worker class for execution
 */
export class RedisGetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    try {
      const value = await redisClient.get(key);

      return {
        successBoolean: true,
        responseString: `Redis GET ${ key }: ${ value || '(nil)' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting Redis key: ${ (error as Error).message }`,
      };
    }
  }
}
