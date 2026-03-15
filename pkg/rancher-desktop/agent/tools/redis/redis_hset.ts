import { BaseTool, ToolResponse } from '../base';
import { redisClient } from '../../database/RedisClient';

/**
 * Redis Hset Tool - Worker class for execution
 */
export class RedisHsetWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, field, value } = input;

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
