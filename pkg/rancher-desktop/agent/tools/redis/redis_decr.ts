import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Redis Decr Tool - Worker class for execution
 */
export class RedisDecrWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    try {
      const newValue = await redisClient.decr(key);

      return {
        successBoolean: true,
        responseString: `Redis DECR ${ key }: new value is ${ newValue }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error decrementing Redis key: ${ (error as Error).message }`,
      };
    }
  }
}
