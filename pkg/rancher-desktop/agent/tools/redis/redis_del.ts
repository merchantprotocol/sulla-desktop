import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Redis Del Tool - Worker class for execution
 */
export class RedisDelWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { keys } = input;

    try {
      const count = await redisClient.del(keys);

      return {
        successBoolean: true,
        responseString: `Redis DEL: ${ count } key(s) deleted (${ keys.join(', ') })`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error deleting Redis keys: ${ (error as Error).message }`,
      };
    }
  }
}
