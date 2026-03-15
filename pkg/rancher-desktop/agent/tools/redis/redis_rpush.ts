import { BaseTool, ToolResponse } from '../base';
import { redisClient } from '../../database/RedisClient';

/**
 * Redis Rpush Tool - Worker class for execution
 */
export class RedisRpushWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key, values } = input;

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
