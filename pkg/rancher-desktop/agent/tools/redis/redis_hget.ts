import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Redis Hget Tool - Worker class for execution
 */
export class RedisHgetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, field } = input;

    try {
      const value = await redisClient.hget(key, field);

      return {
        successBoolean: true,
        responseString: `Redis HGET ${ key } ${ field }: ${ value || '(nil)' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting Redis hash field: ${ (error as Error).message }`,
      };
    }
  }
}
