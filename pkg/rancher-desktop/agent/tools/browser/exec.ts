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
 *
 * Silent-failure hardening (fix/eval-js-silent-failures):
 *  - Single expressions are auto-returned (devtools-console semantics) —
 *    models routinely send `document.title` and expect a value back.
 *  - Syntax errors are caught by pre-validation in the main process and
 *    reported as errors; they used to come back `Result: undefined` with
 *    success=true because the bridge swallowed the compile rejection.
 *  - The `timeout` param is actually enforced (it was accepted and
 *    silently ignored — code awaiting a never-settling promise hung the
 *    tool call forever).
 *  - Results and console args are serialized defensively in-page so
 *    circular structures / DOM nodes can't crash the response path or
 *    the user's own console.log calls.
 */

/** How the user code must be wrapped to produce a value. */
export type CodeForm = 'expression' | 'body' | 'invalid';

/**
 * Classify user code: a single expression gets auto-returned (console
 * semantics); anything that only parses as a statement list runs as a
 * function body (explicit `return` sends the value); code that parses as
 * neither is a syntax error we can report without a page round-trip.
 *
 * Both probes compile inside an async arrow so top-level `await` is legal
 * exactly like it will be in the page wrapper. `new Function` compiles
 * without executing, and main-process V8 matches the renderer's parser.
 */
export function classifyCode(code: string): { form: CodeForm; parseError?: string } {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`"use strict"; return (async () => (\n${ code }\n));`);

    return { form: 'expression' };
  } catch { /* not a single expression — try statement-list form */ }

  try {
    // eslint-disable-next-line no-new-func
    new Function(`"use strict"; return (async () => {\n${ code }\n});`);

    return { form: 'body' };
  } catch (e) {
    return { form: 'invalid', parseError: e instanceof Error ? e.message : String(e) };
  }
}

/** Build the in-page diagnostic wrapper around the user code. Exported for tests. */
export function buildWrapper(code: string, form: 'expression' | 'body'): string {
  const invocation = form === 'expression'
    ? `__result = await (async function() { return (\n${ code }\n); })();`
    : `__result = await (async function() {\n${ code }\n})();`;

  return `
(async function() {
  const __logs = [];
  // Circular-safe stringifier — console.log of a circular object used to
  // throw inside the USER'S code because the capture called bare
  // JSON.stringify on every argument.
  const __str = function(a) {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  };
  const __origLog = console.log;
  const __origWarn = console.warn;
  const __origError = console.error;
  console.log = function() { __logs.push('[log] ' + Array.from(arguments).map(__str).join(' ')); __origLog.apply(console, arguments); };
  console.warn = function() { __logs.push('[warn] ' + Array.from(arguments).map(__str).join(' ')); __origWarn.apply(console, arguments); };
  console.error = function() { __logs.push('[error] ' + Array.from(arguments).map(__str).join(' ')); __origError.apply(console, arguments); };

  // Clear __sulla.__log before execution
  if (window.__sulla && Array.isArray(window.__sulla.__log)) {
    window.__sulla.__log.length = 0;
  }

  // Track mutations. document.body can legitimately be null (about:blank,
  // document-start timing) — observing null threw before the user code
  // even ran, and the bridge turned that into a silent undefined.
  let __mutationCount = 0;
  const __observer = new MutationObserver(function(mutations) {
    __mutationCount += mutations.length;
  });
  if (document.body) {
    __observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  // Track navigation
  const __startUrl = location.href;

  let __result, __error, __errorStack;
  const __t0 = performance.now();
  try {
    ${ invocation }
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

  // Serialize the result defensively IN PAGE. executeJavaScript clones the
  // whole return envelope; a circular / non-cloneable __result used to
  // reject the clone and lose every diagnostic with it.
  let __safeResult = __result;
  let __resultNote = null;
  if (__result !== null && (typeof __result === 'object' || typeof __result === 'function')) {
    try {
      __safeResult = JSON.parse(JSON.stringify(__result));
    } catch (e) {
      __safeResult = String(__result);
      __resultNote = 'Result was not JSON-serializable (' + (e.message || String(e)) + ') — returning String(result). Return plain data (objects/arrays/primitives), not DOM nodes or circular structures.';
    }
  }

  return {
    result: __safeResult,
    resultNote: __resultNote,
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
}

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

    // Pre-validate syntax in the main process. A compile error in the page
    // used to be swallowed by the bridge and surface as a silent
    // `Result: undefined` with success=true.
    const classified = classifyCode(code);
    if (classified.form === 'invalid') {
      return {
        successBoolean: false,
        responseString: `[${ result.assetId }] Syntax error in code: ${ classified.parseError }\n`
          + 'The code never reached the page. Fix the syntax and retry. '
          + 'Single expressions are auto-returned; multi-statement code needs an explicit `return` to send a value back.',
      };
    }

    try {
      const wrapped = buildWrapper(code, classified.form);

      // Enforce the documented timeout — it was accepted and ignored, so
      // code awaiting a never-settling promise hung the tool call forever.
      // On timeout the page script may keep running; we just stop waiting.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `eval_js timed out after ${ timeout }ms — the code is likely awaiting a promise that never settles. `
            + 'The page script may still be running. Prefer polling with short evals over long in-page waits.',
          )),
          timeout,
        );
      });

      const execPromise = result.bridge.execInPageStrict(wrapped);
      // If the timeout wins the race, the exec promise may reject later —
      // pre-attach a handler so that never becomes an unhandled rejection.
      execPromise.catch(() => { /* reported via the race or irrelevant after timeout */ });

      let returnValue: any;
      try {
        returnValue = await Promise.race([execPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // The strict bridge propagates rejections, so a missing envelope here
      // means something exotic (e.g. the page overrode Promise). Report it
      // rather than printing a fake `Result: undefined`.
      if (!returnValue || typeof returnValue !== 'object') {
        return {
          successBoolean: false,
          responseString: `[${ result.assetId }] Execution returned no diagnostic envelope (got ${ typeof returnValue }). `
            + 'The page may have navigated mid-execution or interfered with the wrapper. Retry, or use browser/snapshot to check page state.',
        };
      }

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
      let serialized: string;
      if (val === undefined) {
        serialized = 'undefined';
      } else if (val === null) {
        serialized = 'null';
      } else if (typeof val === 'string') {
        serialized = val;
      } else {
        // In-page serialization already JSON-round-tripped objects, but stay
        // defensive — a crash here used to destroy a successful result.
        try {
          serialized = JSON.stringify(val, null, 2);
        } catch (e) {
          serialized = `${ String(val) } (unserializable: ${ e instanceof Error ? e.message : String(e) })`;
        }
      }

      parts.push(`Result: ${ serialized }`);
      if (returnValue?.resultNote) {
        parts.push(`Note: ${ returnValue.resultNote }`);
      }

      // The #1 confusion with this tool: statement-form code that never
      // returns. Say so explicitly instead of leaving a bare `undefined`.
      if (!returnValue?.error && val === undefined && classified.form === 'body' && !/\breturn\b/.test(code)) {
        parts.push('Note: the code ran as a function body and returned nothing. Add an explicit `return <value>` to send a value back (single expressions are auto-returned).');
      }

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
