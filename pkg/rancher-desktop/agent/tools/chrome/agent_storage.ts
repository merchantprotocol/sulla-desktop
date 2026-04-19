import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Agent Storage Tool — persistent key-value store for agent state.
 *
 * Backed by SullaSettingsModel (Redis + PG + file fallback).
 */
export class AgentStorageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();
    const action = input.action as string;

    try {
      switch (action) {
      case 'get': {
        const keys = input.keys
          ? (Array.isArray(input.keys) ? input.keys : [input.keys])
          : null;
        const result = await chrome.storage.local.get(keys);
        const entries = Object.entries(result);

        if (entries.length === 0) {
          return {
            successBoolean: true,
            responseString: keys
              ? `No values found for key(s): ${ keys.join(', ') }`
              : 'Storage is empty.',
          };
        }

        const lines = entries.map(([k, v]) => `  ${ k }: ${ JSON.stringify(v) }`);

        return {
          successBoolean: true,
          responseString: `${ entries.length } value(s):\n${ lines.join('\n') }`,
        };
      }

      case 'set': {
        if (!input.data || typeof input.data !== 'object') {
          return { successBoolean: false, responseString: '"data" must be an object of key-value pairs.' };
        }

        await chrome.storage.local.set(input.data);
        const keys = Object.keys(input.data);

        return {
          successBoolean: true,
          responseString: `Stored ${ keys.length } value(s): ${ keys.join(', ') }`,
        };
      }

      case 'remove': {
        if (!input.keys) {
          return { successBoolean: false, responseString: '"keys" is required for remove action.' };
        }

        const keys = Array.isArray(input.keys) ? input.keys : [input.keys];

        await chrome.storage.local.remove(keys);

        return {
          successBoolean: true,
          responseString: `Removed ${ keys.length } key(s): ${ keys.join(', ') }`,
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use get, set, or remove.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Storage operation failed: ${ (error as Error).message }` };
    }
  }
}
