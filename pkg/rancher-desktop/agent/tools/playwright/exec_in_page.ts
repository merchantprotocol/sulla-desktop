import { BaseTool, ToolResponse } from '../base';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Exec In Page Tool - Execute arbitrary JavaScript in the page context.
 *
 * Wraps the code with console capture so any console.log/warn/error
 * output during execution is returned alongside the result.
 */
export class ExecInPageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { code } = input;
    if (!code || typeof code !== 'string') {
      return { successBoolean: false, responseString: 'code parameter is required.' };
    }

    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      // Wrap code to capture console output + errors + return value
      const wrapped = `
(async function() {
  const __logs = [];
  const __origLog = console.log;
  const __origWarn = console.warn;
  const __origError = console.error;
  console.log = function() { __logs.push('[log] ' + Array.from(arguments).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); __origLog.apply(console, arguments); };
  console.warn = function() { __logs.push('[warn] ' + Array.from(arguments).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); __origWarn.apply(console, arguments); };
  console.error = function() { __logs.push('[error] ' + Array.from(arguments).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); __origError.apply(console, arguments); };
  let __result, __error;
  try {
    __result = await (async function() { ${code} })();
  } catch(e) {
    __error = e.message || String(e);
  }
  console.log = __origLog;
  console.warn = __origWarn;
  console.error = __origError;
  return { result: __result, error: __error, logs: __logs };
})()`;

      const returnValue = await result.bridge.execInPage(wrapped) as any;

      const parts: string[] = [];

      if (returnValue?.error) {
        parts.push(`Error: ${ returnValue.error }`);
      }

      if (returnValue?.logs?.length > 0) {
        parts.push('Console:');
        for (const line of returnValue.logs.slice(0, 50)) {
          parts.push(`  ${ line }`);
        }
      }

      const val = returnValue?.result;
      const serialized = val === undefined ? 'undefined'
        : val === null ? 'null'
          : typeof val === 'string' ? val
            : JSON.stringify(val, null, 2);

      parts.push(`Result: ${ serialized }`);

      return {
        successBoolean: !returnValue?.error,
        responseString: `[${ result.assetId }]\n${ parts.join('\n') }`,
      };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Execution failed: ${ String(err) }`,
      };
    }
  }
}
