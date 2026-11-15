import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideHeadlessProcessReap,
  HEADLESS_BROWSER_IDLE_MS,
  isHeadlessBrowser,
  isProtectedProcess,
  parseProcessCpuTime,
} from './HeadlessBrowserReaperPolicy.ts';

function decision(command: string, args: string, idleForMs: number, ppid = 42) {
  return decideHeadlessProcessReap({
    candidate: isHeadlessBrowser({ command, args }),
    protectedProcess: isProtectedProcess({ command, args }),
    orphaned: ppid === 1,
    idleForMs,
  });
}

test('idle headless Chrome at five minutes is reaped', () => {
  // risk: process safety — leaked headless browser processes must be reclaimed.
  assert.deepEqual(decision('chrome', 'chrome --headless=new', HEADLESS_BROWSER_IDLE_MS), { reap: true, reason: 'idle' });
});

test('headless Chrome with recent CPU activity is spared', () => {
  // risk: process safety — do not interrupt active browser work.
  assert.deepEqual(decision('chrome', 'chrome --headless', HEADLESS_BROWSER_IDLE_MS - 60_000), { reap: false });
});

test('user Chrome without --headless is spared', () => {
  // risk: process safety — never terminate the user's interactive browser.
  assert.deepEqual(decision('Google Chrome', 'Google Chrome --profile-directory=Default', HEADLESS_BROWSER_IDLE_MS * 2), { reap: false });
});

test('Electron helper is spared even when its arguments mention headless Chrome', () => {
  // risk: process safety — do not terminate Sulla/Electron application helpers.
  assert.deepEqual(decision('Sulla Helper (Renderer)', 'Sulla.app/Contents/Frameworks/Electron Framework --headless', HEADLESS_BROWSER_IDLE_MS * 2), { reap: false });
});

test('orphaned idle headless Chromium is reaped after five minutes', () => {
  // risk: process safety — reclaim idle browser processes left behind after their owner exits.
  assert.deepEqual(decision('chromium', 'chromium --headless', HEADLESS_BROWSER_IDLE_MS, 1), { reap: true, reason: 'orphaned-idle' });
});

test('process CPU time parser handles macOS and Linux ps formats', () => {
  // risk: process safety — malformed CPU readings could reap active browser trees.
  assert.equal(parseProcessCpuTime('02:03.50'), 123.5);
  assert.equal(parseProcessCpuTime('01:02:03'), 3723);
  assert.equal(parseProcessCpuTime('1-02:03:04'), 93_784);
});
