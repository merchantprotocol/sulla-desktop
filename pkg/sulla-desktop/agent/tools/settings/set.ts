// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { BaseTool, ToolResponse } from '../base';

import { isProtectedSetting } from '@pkg/main/cloud/cloudSettings';

const JSON_CASTS = ['json', 'array'];

/**
 * Authoritative settings write. Goes through SullaSettingsModel so
 * Postgres and the Redis cache stay in sync. Do NOT use redis_hset
 * on the sulla_settings hash — that is blocked and this is the
 * replacement.
 *
 * JSON values arrive as a JSON string with cast "json" (or "array").
 * This tool parses that string before storing it, so the model does
 * not double-encode it. Object/array settings cannot be overwritten
 * by a plain string.
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
    if (property === 'hostAccess') {
      return { successBoolean: false, responseString: 'Host access can only be changed by the human in Preferences.' };
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

    const cast: string | undefined = typeof input.cast === 'string' && input.cast.trim() ? input.cast.trim() : undefined;
    const isJsonCast = cast !== undefined && JSON_CASTS.includes(cast);

    // Resolve the value to store. A json/array cast takes a JSON string and
    // parses it; anything else is stored as given.
    let value: any = input.value;
    if (isJsonCast && typeof input.value === 'string') {
      try {
        value = JSON.parse(input.value);
      } catch (error) {
        return {
          successBoolean: false,
          responseString: `Setting "${ property }" was NOT written: value is not valid JSON (${ (error as Error).message }). Pass the value as a JSON string with cast "json".`,
        };
      }
    }

    try {
      // Read the current value so an object/array setting is never silently
      // replaced by a plain string.
      const current = await SullaSettingsModel.get(property, null);
      const currentIsStructured = current !== null && typeof current === 'object';
      if (currentIsStructured && !isJsonCast) {
        return {
          successBoolean: false,
          responseString: `Setting "${ property }" was NOT written: it holds a JSON ${ Array.isArray(current) ? 'array' : 'object' }. Pass the new value as a JSON string with cast "json" so it is not replaced by a plain string.`,
        };
      }

      await SullaSettingsModel.set(property, value, cast);
      return {
        successBoolean: true,
        responseString: JSON.stringify({
          property,
          value,
          cast:   cast ?? null,
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
