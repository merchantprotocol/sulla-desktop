import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Redis Expire Tool - Worker class for execution
 */
export class RedisExpireWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, seconds } = input;

    try {
      const result = await redisClient.expire(key, seconds);

      return {
        successBoolean: true,
        responseString: `Redis EXPIRE ${ key }: ${ result === 1 ? `expiration set to ${ seconds } seconds` : 'key does not exist or already has expiration' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error setting Redis key expiration: ${ (error as Error).message }`,
      };
    }
  }
}
