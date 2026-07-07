/**
 * @jest-environment node
 *
 * Node environment on purpose: nothing here touches the DOM (the tab bridge
 * is mocked, classifyCode/buildWrapper are pure), and base.ts transitively
 * reaches the pg client, which needs Node globals (TextEncoder) that the
 * default jsdom environment doesn't provide.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// ESM tests in this repo mock via unstable_mockModule + dynamic import
// (see meta/__tests__/browser_tab.test.ts) — plain jest.mock does not
// intercept under --experimental-vm-modules.
const mockResolveBridge = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../resolve_bridge', () => ({
  resolveBridge:    mockResolveBridge,
  isBridgeResolved: (r: any) => !!r?.bridge,
}));
jest.unstable_mockModule('../screenshot_store', () => ({ saveScreenshot: jest.fn() }));
// GuestBridge and friends import electron, which doesn't exist under jest.
jest.unstable_mockModule('electron', () => ({
  app:           {},
  ipcMain:       { on: jest.fn(), handle: jest.fn() },
  nativeImage:   { createFromBuffer: jest.fn(), createFromDataURL: jest.fn() },
  BrowserWindow: class {},
  WebContentsView: class {},
}));

async function loadModule() {
  return import('../exec');
}

function makeCaller(bridge: Record<string, unknown>) {
  mockResolveBridge.mockResolvedValue({ bridge, assetId: 'tab-1' });

  return async(input: Record<string, unknown>) => {
    const { ExecInPageWorker } = await loadModule();
    const worker = new ExecInPageWorker();

    // _validatedCall is protected; tests drive it directly.
    return (worker as any)._validatedCall(input);
  };
}

/** A well-formed diagnostic envelope, as the in-page wrapper produces. */
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    result:     undefined,
    resultNote: null,
    error:      undefined,
    errorStack: undefined,
    logs:       [],
    sullaLog:   [],
    timing:     1.5,
    mutations:  0,
    navigated:  false,
    url:        'about:blank',
    title:      't',
    ...overrides,
  };
}

beforeEach(() => {
  mockResolveBridge.mockReset();
});

describe('classifyCode', () => {
  it('classifies single expressions (devtools semantics)', async() => {
    const { classifyCode } = await loadModule();

    expect(classifyCode('1 + 1').form).toBe('expression');
    expect(classifyCode('document.title').form).toBe('expression');
    expect(classifyCode('fetch("/x")').form).toBe('expression');
    expect(classifyCode('(async () => { return 1; })()').form).toBe('expression');
  });

  it('classifies expressions using top-level await', async() => {
    const { classifyCode } = await loadModule();

    expect(classifyCode('await fetch("/x")').form).toBe('expression');
  });

  it('classifies statement lists as body', async() => {
    const { classifyCode } = await loadModule();

    expect(classifyCode('const x = 1; return x + 1;').form).toBe('body');
    expect(classifyCode('let a = 2;\nreturn a;').form).toBe('body');
    // Trailing semicolon defeats the expression parse — falls back to body.
    expect(classifyCode('1 + 1;').form).toBe('body');
  });

  it('classifies syntax errors as invalid with a parse error', async() => {
    const { classifyCode } = await loadModule();
    const res = classifyCode('const = 5;');

    expect(res.form).toBe('invalid');
    expect(res.parseError).toBeTruthy();
  });

  it('is not fooled by trailing line comments on expressions', async() => {
    const { classifyCode } = await loadModule();

    expect(classifyCode('document.title // read the title').form).toBe('expression');
  });
});

describe('buildWrapper', () => {
  it('auto-returns expression-form code', async() => {
    const { buildWrapper } = await loadModule();
    const w = buildWrapper('1 + 1', 'expression');

    expect(w).toContain('return (\n1 + 1\n);');
  });

  it('embeds body-form code without an implicit return', async() => {
    const { buildWrapper } = await loadModule();
    const w = buildWrapper('const x = 1; return x;', 'body');

    expect(w).toContain('const x = 1; return x;');
    expect(w).not.toContain('return (\nconst');
  });

  it('guards MutationObserver against a null document.body', async() => {
    const { buildWrapper } = await loadModule();

    expect(buildWrapper('1', 'expression')).toContain('if (document.body)');
  });

  it('captures console with a circular-safe stringifier', async() => {
    const { buildWrapper } = await loadModule();

    expect(buildWrapper('1', 'expression')).toContain('catch (e) { return String(a); }');
  });
});

describe('ExecInPageWorker._validatedCall', () => {
  it('reports syntax errors without a page round-trip (was: silent Result: undefined)', async() => {
    const execInPageStrict = jest.fn();
    const call = makeCaller({ execInPageStrict });

    const res = await call({ code: 'const = 5;' });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('Syntax error');
    expect(execInPageStrict).not.toHaveBeenCalled();
  });

  it('surfaces bridge rejections as errors (was: swallowed to undefined)', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('An object could not be cloned')),
    });

    const res = await call({ code: 'return window' });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('Execution failed');
    expect(res.responseString).toContain('could not be cloned');
  });

  it('enforces the timeout param (was: accepted and ignored — hung forever)', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockReturnValue(new Promise(() => { /* never settles */ })),
    });

    const res = await call({ code: 'await new Promise(() => {})', timeout: 50 });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('timed out after 50ms');
  });

  it('returns the value from a successful expression', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(envelope({ result: 2 })),
    });

    const res = await call({ code: '1 + 1' });

    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('Result: 2');
  });

  it('hints when body-form code returns nothing and has no return statement', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(envelope()),
    });

    const res = await call({ code: 'const x = 1; console.log(x);' });

    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('ran as a function body and returned nothing');
  });

  it('does not hint when body-form code explicitly returns a value', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(envelope({ result: 'ok' })),
    });

    const res = await call({ code: 'const x = "ok"; return x;' });

    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('Result: ok');
    expect(res.responseString).not.toContain('returned nothing');
  });

  it('passes through the in-page serialization note for unserializable results', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(envelope({
        result:     '[object HTMLDivElement]',
        resultNote: 'Result was not JSON-serializable (circular) — returning String(result).',
      })),
    });

    const res = await call({ code: 'return document.createElement("div")' });

    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('Note: Result was not JSON-serializable');
  });

  it('reports a lost diagnostic envelope instead of faking Result: undefined', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    });

    const res = await call({ code: '1 + 1' });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('no diagnostic envelope');
  });

  it('reports in-page runtime errors with stack', async() => {
    const call = makeCaller({
      execInPageStrict: jest.fn<() => Promise<unknown>>().mockResolvedValue(envelope({
        error:      'boom',
        errorStack: 'Error: boom\n  at <anonymous>',
      })),
    });

    const res = await call({ code: 'throw new Error("boom")' });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('Error: boom');
    expect(res.responseString).toContain('Stack:');
  });
});
