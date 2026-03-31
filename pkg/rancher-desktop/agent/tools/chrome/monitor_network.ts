import { BaseTool, ToolResponse } from '../base';
import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Monitor Network Tool — subscribe to webRequest events and collect results.
 */
export class MonitorNetworkWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();
    const action = input.action as string;

    try {
      switch (action) {
      case 'capture': {
        const durationMs = (input.durationSeconds || 5) * 1000;
        const urlFilter = input.urlFilter || '';
        const collected: any[] = [];

        const onCompleted = (details: any) => {
          if (!urlFilter || details.url.includes(urlFilter)) {
            collected.push({
              url:    details.url,
              method: details.method,
              status: details.statusCode,
              type:   details.type,
            });
          }
        };

        const onError = (details: any) => {
          if (!urlFilter || details.url.includes(urlFilter)) {
            collected.push({
              url:    details.url,
              method: details.method,
              error:  details.error,
              type:   details.type,
            });
          }
        };

        chrome.webRequest.onCompleted.addListener(onCompleted);
        chrome.webRequest.onErrorOccurred.addListener(onError);

        await new Promise(resolve => setTimeout(resolve, durationMs));

        chrome.webRequest.onCompleted.removeListener(onCompleted);
        chrome.webRequest.onErrorOccurred.removeListener(onError);

        if (collected.length === 0) {
          return {
            successBoolean: true,
            responseString: `No network requests captured in ${ input.durationSeconds || 5 }s${ urlFilter ? ` matching "${ urlFilter }"` : '' }.`,
          };
        }

        const lines = collected.map(r =>
          r.error
            ? `  ERROR ${ r.method } ${ r.url } — ${ r.error }`
            : `  ${ r.status } ${ r.method } ${ r.url } (${ r.type })`,
        );

        return {
          successBoolean: true,
          responseString: `Captured ${ collected.length } request(s) in ${ input.durationSeconds || 5 }s:\n${ lines.join('\n') }`,
        };
      }

      case 'watch_errors': {
        const durationMs = (input.durationSeconds || 10) * 1000;
        const errors: any[] = [];

        const onError = (details: any) => {
          errors.push({ url: details.url, method: details.method, error: details.error, type: details.type });
        };

        const onFailed = (details: any) => {
          if (details.statusCode >= 400) {
            errors.push({ url: details.url, method: details.method, status: details.statusCode, type: details.type });
          }
        };

        chrome.webRequest.onErrorOccurred.addListener(onError);
        chrome.webRequest.onCompleted.addListener(onFailed);

        await new Promise(resolve => setTimeout(resolve, durationMs));

        chrome.webRequest.onErrorOccurred.removeListener(onError);
        chrome.webRequest.onCompleted.removeListener(onFailed);

        if (errors.length === 0) {
          return {
            successBoolean: true,
            responseString: `No network errors in ${ input.durationSeconds || 10 }s. All requests succeeded.`,
          };
        }

        const lines = errors.map(e =>
          e.error
            ? `  ERROR ${ e.method } ${ e.url } — ${ e.error }`
            : `  ${ e.status } ${ e.method } ${ e.url }`,
        );

        return {
          successBoolean: true,
          responseString: `${ errors.length } error(s) in ${ input.durationSeconds || 10 }s:\n${ lines.join('\n') }`,
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use capture or watch_errors.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Network monitor failed: ${ (error as Error).message }` };
    }
  }
}
