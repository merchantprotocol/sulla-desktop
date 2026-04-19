import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Redis Hgetall Tool - Worker class for execution
 */
export class RedisHgetallWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { key } = input;

    try {
      const obj = await redisClient.hgetall(key);

      if (!obj || Object.keys(obj).length === 0) {
        return {
          successBoolean: false,
          responseString: `Redis HGETALL ${ key }: hash is empty or does not exist`,
        };
      }

      const fieldsStr = Object.entries(obj)
        .map(([field, value]) => `  ${ field }: ${ value }`)
        .join('\n');

      return {
        successBoolean: true,
        responseString: `Redis HGETALL ${ key } (${ Object.keys(obj).length } fields):\n${ fieldsStr }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting Redis hash: ${ (error as Error).message }`,
      };
    }
  }
}
