import { BaseTool, ToolResponse } from '../base';
import { saveScreenshot } from './screenshot_store';
import { resolveBridge, isBridgeResolved } from './resolve_bridge';

/**
 * Exec In Page Tool - Execute arbitrary JavaScript in the page context.
 *
 * Wraps the code with console capture so any console.log/warn/error
 * output during execution is returned alongside the result.
 *
 * Enhanced with __sulla log capture, timing, mutation counting,
 * navigation detection, optional waitFor/waitForIdle/screenshot,
 * and full error stack traces.
 */
export class ExecInPageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { code, screenshot, waitFor, waitForIdle, timeout = 30000 } = input;
    if (!code || typeof code !== 'string') {
      return { successBoolean: false, responseString: 'code parameter is required.' };
    }

    const result = await resolveBridge(input.assetId);
    if (!isBridgeResolved(result)) return result;

    try {
      // Wrap code to capture console output, __sulla logs, timing,
      // mutations, navigation, errors with stacks, and page state.
      const wrapped = `
(async function() {
  const __logs = [];
  const __origLog = console.log;
  const __origWarn = console.warn;
  const __origError = console.error;
  console.log = function() { __logs.push('[log] ' + Array.from(arguments).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); __origLog.apply(console, arguments); };
  console.warn = function() { __logs.push('[warn] ' + Array.from(arguments).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); __origWarn.apply(console, arguments); };
  console.error = function() { __logs.push('[error] ' + Array.from(arguments).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); __origError.apply(console, arguments); };

  // Clear __sulla.__log before execution
  if (window.__sulla && Array.isArray(window.__sulla.__log)) {
    window.__sulla.__log.length = 0;
  }

  // Track mutations
  let __mutationCount = 0;
  const __observer = new MutationObserver(function(mutations) {
    __mutationCount += mutations.length;
  });
  __observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

  // Track navigation
  const __startUrl = location.href;

  let __result, __error, __errorStack;
  const __t0 = performance.now();
  try {
    __result = await (async function() { ${ code } })();
  } catch(e) {
    __error = e.message || String(e);
    __errorStack = e.stack || null;
  }
  const __timing = performance.now() - __t0;

  // Stop observing
  __observer.disconnect();

  // Restore console
  console.log = __origLog;
  console.warn = __origWarn;
  console.error = __origError;

  // Gather __sulla log entries
  const __sullaLog = (window.__sulla && Array.isArray(window.__sulla.__log))
    ? window.__sulla.__log.slice()
    : [];

  return {
    result: __result,
    error: __error,
    errorStack: __errorStack,
    logs: __logs,
    sullaLog: __sullaLog,
    timing: __timing,
    mutations: __mutationCount,
    navigated: location.href !== __startUrl,
    url: location.href,
    title: document.title,
  };
})()`;

      const returnValue = await result.bridge.execInPage(wrapped) as any;

      // Post-execution: waitFor
      if (waitFor && typeof waitFor === 'string') {
        try {
          await result.bridge.execInPage(
            `window.__sulla && window.__sulla.waitFor ? window.__sulla.waitFor(${ JSON.stringify(waitFor) }) : document.querySelector(${ JSON.stringify(waitFor) })`,
          );
        } catch { /* waitFor is best-effort */ }
      }

      // Post-execution: waitForIdle
      if (waitForIdle) {
        try {
          await result.bridge.execInPage(
            `window.__sulla && window.__sulla.waitForIdle ? window.__sulla.waitForIdle() : new Promise(r => setTimeout(r, 500))`,
          );
        } catch { /* waitForIdle is best-effort */ }
      }

      // Build response parts
      const parts: string[] = [];

      if (returnValue?.error) {
        parts.push(`Error: ${ returnValue.error }`);
        if (returnValue?.errorStack) {
          parts.push(`Stack: ${ returnValue.errorStack }`);
        }
      }

      if (returnValue?.logs?.length > 0) {
        parts.push('Console:');
        for (const line of returnValue.logs.slice(0, 100)) {
          parts.push(`  ${ line }`);
        }
      }

      if (returnValue?.sullaLog?.length > 0) {
        parts.push('Sulla Log:');
        for (const entry of returnValue.sullaLog.slice(0, 100)) {
          parts.push(`  ${ typeof entry === 'string' ? entry : JSON.stringify(entry) }`);
        }
      }

      const val = returnValue?.result;
      const serialized = val === undefined
        ? 'undefined'
        : val === null
          ? 'null'
          : typeof val === 'string'
            ? val
            : JSON.stringify(val, null, 2);

      parts.push(`Result: ${ serialized }`);
      parts.push(`Timing: ${ returnValue?.timing?.toFixed(1) ?? '?' }ms`);
      parts.push(`Mutations: ${ returnValue?.mutations ?? 0 }`);
      parts.push(`Navigated: ${ returnValue?.navigated ?? false }`);
      parts.push(`URL: ${ returnValue?.url ?? '?' }`);
      parts.push(`Title: ${ returnValue?.title ?? '?' }`);

      const responseObj: any = {
        successBoolean: !returnValue?.error,
        responseString: `[${ result.assetId }]\n${ parts.join('\n') }`,
      };

      // Include sullaLog as structured field
      if (returnValue?.sullaLog?.length > 0) {
        responseObj.sullaLog = returnValue.sullaLog;
      }

      // Post-execution: screenshot (persisted to disk, returns compact ref)
      if (screenshot) {
        try {
          const screenshotData = await result.bridge.captureScreenshot({ format: 'jpeg', quality: 80 });
          if (screenshotData?.base64) {
            const ref = await saveScreenshot(screenshotData.base64, screenshotData.mediaType);
            responseObj.screenshot = ref;
          }
        } catch { /* screenshot is best-effort */ }
      }

      return responseObj as ToolResponse;
    } catch (err) {
      const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);

      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Execution failed: ${ errMsg }`,
      };
    }
  }
}
