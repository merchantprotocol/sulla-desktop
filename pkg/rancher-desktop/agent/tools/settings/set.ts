import { isProtectedSetting } from '@pkg/main/cloud/cloudSettings';

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Authoritative settings write. Goes through SullaSettingsModel so
 * Postgres and the Redis cache stay in sync. Do NOT use redis_hset
 * on the sulla_settings hash — that is blocked and this is the
 * replacement.
 */
export class SettingsSetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const property = typeof input?.property === 'string' ? input.property.trim() : '';
    if (!property) {
      return {
        successBoolean: false,
        responseString: 'property is required.',
      };
    }
    if (isProtectedSetting(property)) {
      // Cloud sync / remote access switches are the owner's decision and are
      // changed only in Settings → Sulla Cloud. An agent (possibly steered by
      // untrusted content) must not be able to turn on uploads or remote control.
      return {
        successBoolean: false,
        responseString: `"${ property }" is a Sulla Cloud security setting. Only the owner can change it, in Settings → Sulla Cloud.`,
      };
    }
    if (!('value' in (input || {}))) {
      return {
        successBoolean: false,
        responseString: 'value is required.',
      };
    }

    try {
      await SullaSettingsModel.set(property, input.value, input.cast);
      return {
        successBoolean: true,
        responseString: JSON.stringify({
          property,
          value:  input.value,
          cast:   input.cast ?? null,
          source: 'SullaSettingsModel',
          note:   'Wrote through Postgres and Redis cache.',
        }, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error writing setting "${ property }": ${ (error as Error).message }`,
      };
    }
  }
}
