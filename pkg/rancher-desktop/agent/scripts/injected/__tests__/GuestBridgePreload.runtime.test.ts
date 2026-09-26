import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildGuestBridgeScript } from '../GuestBridgePreload';

/**
 * The guest bridge is shipped as a string and eval'd into every frame at
 * document-start, so a syntax or runtime error silently breaks every agent
 * browser tool. Execute it for real in jsdom and check the surface the main
 * process (GuestBridge.ts) depends on.
 */
const GUEST_BRIDGE_METHODS = [
  'click', 'focusElement', 'getActionableMarkdown', 'getFormValues', 'getPageText', 'getReaderContent',
  'getScrollInfo', 'pressKey', 'scrollAndCapture', 'scrollTo', 'scrollToTop', 'searchInPage', 'setValue',
  'waitForSelector', 'detectLoginForm',
];

describe('guest bridge injection script', () => {
  afterEach(() => {
    delete (window as any).sullaBridge;
    delete (window as any).__sulla;
    delete (window as any).__sullaBridgeEmit;
    jest.useRealTimers();
  });

  it('evaluates cleanly and installs window.sullaBridge + window.__sulla', () => {
    document.body.innerHTML = '<main><h1>Hello</h1><button id="go">Go</button></main>';
    (window as any).__sullaBridgeEmit = jest.fn();

    // eslint-disable-next-line no-eval
    (0, eval)(buildGuestBridgeScript());

    const bridge = (window as any).sullaBridge;
    expect(bridge).toBeDefined();
    for (const method of GUEST_BRIDGE_METHODS) expect(typeof bridge[method]).toBe('function');
    for (const fn of ['dehydrate', 'waitFor', 'waitForIdle', 'click', 'fill', 'text']) {
      expect(typeof (window as any).__sulla[fn]).toBe('function');
    }
    // (getPageText uses innerText, which jsdom doesn't implement.)
    expect(typeof bridge.getPageText()).toBe('string');
    expect(String(bridge.getActionableMarkdown())).toContain('Go');
  });

  it('no longer streams passive page events or patches page globals', () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<article>' + 'Long readable content. '.repeat(50) + '<button>Buy</button></article>';
    const emit = jest.fn();
    (window as any).__sullaBridgeEmit = emit;
    const pushState = history.pushState;
    const alert = window.alert;

    // eslint-disable-next-line no-eval
    (0, eval)(buildGuestBridgeScript());
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    jest.advanceTimersByTime(5_000);

    const types = emit.mock.calls.map(call => call[0]);
    expect(types).not.toContain('sulla:click');
    expect(types).not.toContain('sulla:pageContent');
    expect(types).not.toContain('sulla:injected');
    expect(history.pushState).toBe(pushState);
    expect(window.alert).toBe(alert);
  });
});
