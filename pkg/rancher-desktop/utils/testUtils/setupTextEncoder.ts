/**
 * Preloaded into all Jest tests (see jest.config.js `setupFiles`, listed
 * BEFORE setupVue so it runs first).
 *
 * The `jsdom` test environment does not expose `TextEncoder`/`TextDecoder`
 * as globals, but Node does. Modules that pull in `pg` (and its
 * dependencies) reference them at import time, so any suite that loads a
 * database model crashes with `ReferenceError: TextEncoder is not defined`
 * before a single test runs. Bridge Node's implementation onto the jsdom
 * global so those suites can load.
 */

import { TextEncoder, TextDecoder } from 'node:util';

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  // Node's TextDecoder is structurally compatible; the DOM lib typing is
  // stricter than the runtime contract these tests rely on.
  globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
}
