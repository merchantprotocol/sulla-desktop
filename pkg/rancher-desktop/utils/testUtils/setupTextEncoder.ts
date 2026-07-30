// Jest setup: bridge Node's TextEncoder/TextDecoder onto the jsdom global.
//
// The `jsdom` test environment does not expose `TextEncoder`/`TextDecoder` as
// globals, but `pg` (and its dependencies) reference them at *import time*. Any
// test suite that loads a database model transitively imports `pg` and crashes
// with `ReferenceError: TextEncoder is not defined` before a single test runs.
//
// Registered first in jest.config.js `setupFiles`, ahead of setupVue, so it
// runs before any test module imports `pg`. Guarded so it is a no-op in any
// environment that already defines these globals.
import { TextEncoder, TextDecoder } from 'node:util';

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
  (globalThis as { TextEncoder: unknown }).TextEncoder = TextEncoder;
}

if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === 'undefined') {
  (globalThis as { TextDecoder: unknown }).TextDecoder = TextDecoder;
}
