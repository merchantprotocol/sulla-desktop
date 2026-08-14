import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Authoritative settings read. Goes through SullaSettingsModel
 * (Redis cache → Postgres → file fallback). Do NOT use redis_hget
 * on the sulla_settings hash — that is blocked and this is the
 * replacement.
 */
export class SettingsGetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const property = typeof input?.property === 'string' ? input.property.trim() : '';
    if (!property) {
      return {
        successBoolean: false,
        responseString: 'property is required (e.g. "heartbeatEnabled", "remoteProvider").',
      };
    }

    try {
      const value = await SullaSettingsModel.get(property, input?.default ?? null);
      return {
        successBoolean: true,
        responseString: JSON.stringify({
          property,
          value,
          source: 'SullaSettingsModel',
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error reading setting "${ property }": ${ (error as Error).message }`,
      };
    }
  }
}
