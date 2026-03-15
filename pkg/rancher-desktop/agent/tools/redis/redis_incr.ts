import { BaseTool, ToolResponse } from '../base';
import { redisClient } from '../../database/RedisClient';

/**
 * Redis Incr Tool - Worker class for execution
 */
export class RedisIncrWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    try {
      const newValue = await redisClient.incr(key);

      return {
        successBoolean: true,
        responseString: `Redis INCR ${ key }: new value is ${ newValue }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error incrementing Redis key: ${ (error as Error).message }`,
      };
    }
  }
}
