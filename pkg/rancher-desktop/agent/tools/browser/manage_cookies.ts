import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Manage Cookies Tool — read, set, and delete browser cookies.
 *
 * Useful for debugging auth, checking login state, and managing sessions
 * across integrated services.
 */
export class ManageCookiesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();
    const action = input.action as string;

    try {
      switch (action) {
      case 'get': {
        if (!input.url || !input.name) {
          return { successBoolean: false, responseString: 'Both "url" and "name" are required for get action.' };
        }
        const cookie = await chrome.cookies.get({ url: input.url, name: input.name });

        if (!cookie) {
          return { successBoolean: true, responseString: `No cookie named "${ input.name }" found for ${ input.url }` };
        }

        return {
          successBoolean: true,
          responseString: `Cookie found:\n  Name: ${ cookie.name }\n  Value: ${ cookie.value }\n  Domain: ${ cookie.domain }\n  Path: ${ cookie.path }\n  Secure: ${ cookie.secure }\n  HttpOnly: ${ cookie.httpOnly }\n  SameSite: ${ cookie.sameSite }`,
        };
      }

      case 'getAll': {
        const details: any = {};

        if (input.url) details.url = input.url;
        if (input.domain) details.domain = input.domain;
        if (input.name) details.name = input.name;

        const cookies = await chrome.cookies.getAll(details);

        if (cookies.length === 0) {
          return { successBoolean: true, responseString: 'No cookies found matching the filter.' };
        }

        const lines = cookies.map(c => `  ${ c.name }=${ c.value.substring(0, 50) }${ c.value.length > 50 ? '...' : '' } (${ c.domain })`);

        return {
          successBoolean: true,
          responseString: `Found ${ cookies.length } cookie(s):\n${ lines.join('\n') }`,
        };
      }

      case 'set': {
        if (!input.url || !input.name || input.value === undefined) {
          return { successBoolean: false, responseString: '"url", "name", and "value" are required for set action.' };
        }
        await chrome.cookies.set({
          url:            input.url,
          name:           input.name,
          value:          input.value,
          domain:         input.domain,
          path:           input.path || '/',
          secure:         input.secure,
          httpOnly:       input.httpOnly,
          expirationDate: input.expirationDate,
        });

        return { successBoolean: true, responseString: `Cookie "${ input.name }" set for ${ input.url }` };
      }

      case 'remove': {
        if (!input.url || !input.name) {
          return { successBoolean: false, responseString: 'Both "url" and "name" are required for remove action.' };
        }
        await chrome.cookies.remove({ url: input.url, name: input.name });

        return { successBoolean: true, responseString: `Cookie "${ input.name }" removed from ${ input.url }` };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use get, getAll, set, or remove.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Cookie operation failed: ${ (error as Error).message }` };
    }
  }
}
