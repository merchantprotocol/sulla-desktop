/**
 * WebviewHostBridge.ts
 *
 * Host-side bridge that communicates with the guest preload script
 * (`window.sullaBridge`) injected into any website webview or iframe.
 *
 * Implements a state machine so that commands automatically wait until
 * the bridge is ready. No tool-level polling or waitForBridgeReady needed.
 *
 * States:
 *   DETACHED   → no webview attached
 *   ATTACHED   → webview attached, waiting for dom-ready
 *   INJECTING  → dom-ready fired, guest script being injected
 *   READY      → sullaBridge available, commands execute immediately
 *   NAVIGATING → page navigation detected, waiting for reinject
 *
 * Usage:
 *   const bridge = new WebviewHostBridge();
 *   bridge.attach(webviewElement);
 *   // Commands auto-wait for READY state:
 *   const markdown = await bridge.getActionableMarkdown();
 *   await bridge.click('@btn-save');
 */

import { buildGuestBridgeScript, BRIDGE_CHANNEL } from './GuestBridgePreload';

type JsonRecord = Record<string, unknown>;

export type BridgeState = 'DETACHED' | 'ATTACHED' | 'INJECTING' | 'READY' | 'NAVIGATING';

export interface WebviewLike {
  src?:                 string;
  getURL?:              () => string;
  executeJavaScript:    (code: string, userGesture?: boolean) => Promise<unknown>;
  addEventListener:     (event: 'dom-ready' | 'ipc-message', listener: (event: unknown) => void) => void;
  removeEventListener?: (event: 'dom-ready' | 'ipc-message', listener: (event: unknown) => void) => void;
}

export interface HostBridgeEventMap {
  injected:     { url: string; title: string; timestamp: number };
  routeChanged: { url: string; path: string; title: string; timestamp: number };
  click: {
    text:       string;
    tagName:    string;
    id:         string;
    name:       string;
    dataTestId: string;
    disabled:   boolean;
    timestamp:  number;
  };
  dialog: {
    dialogType:    'alert' | 'confirm' | 'prompt';
    message:       string;
    defaultValue?: string;
    url:           string;
    title:         string;
    timestamp:     number;
  };
  pageContent: {
    title:         string;
    url:           string;
    content:       string;
    contentLength: number;
    truncated:     boolean;
    timestamp:     number;
  };
  contentAdded: {
    content:       string;
    contentLength: number;
    url:           string;
    title:         string;
    timestamp:     number;
  };
}

type EventHandler<K extends keyof HostBridgeEventMap> = (payload: HostBridgeEventMap[K]) => void;

export interface HostBridgeConfig {
  injectDelayMs?: number;
}

const LOG_PREFIX = '[SULLA_HOST_BRIDGE]';
const READY_TIMEOUT = 15000; // max wait for bridge to become ready

export class WebviewHostBridge {
  private readonly injectDelayMs: number;
  private readonly listeners: {
    [K in keyof HostBridgeEventMap]?: Set<EventHandler<K>>;
  } = {};

  private webview:         WebviewLike | null = null;
  private boundDomReady:   ((event: unknown) => void) | null = null;
  private boundIpcMessage: ((event: unknown) => void) | null = null;
  private lastInjectedForUrl = '';

  // ── State machine ──────────────────────────────────────────────
  private _state: BridgeState = 'DETACHED';
  private readyResolvers: Array<() => void> = [];
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: HostBridgeConfig = {}) {
    this.injectDelayMs = config.injectDelayMs ?? 500;
  }

  /** Current bridge state. */
  get state(): BridgeState {
    return this._state;
  }

  /** Transition to a new state. Resolves waiters when entering READY. */
  private setState(newState: BridgeState): void {
    const prev = this._state;
    if (prev === newState) return;
    this._state = newState;
    console.log(`${ LOG_PREFIX } state: ${ prev } → ${ newState }`);

    if (newState === 'READY') {
      // Resolve all pending waiters
      const resolvers = this.readyResolvers.splice(0);
      for (const resolve of resolvers) resolve();
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
    }
  }

  /**
   * Returns a promise that resolves when the bridge is in READY state.
   * If already READY, resolves immediately. If DETACHED, rejects.
   * All bridge commands call this internally — tools never need to wait manually.
   */
  whenReady(timeoutMs = READY_TIMEOUT): Promise<void> {
    if (this._state === 'READY') return Promise.resolve();
    if (this._state === 'DETACHED') return Promise.reject(new Error('Bridge is detached'));

    return new Promise((resolve, reject) => {
      this.readyResolvers.push(resolve);

      // Safety net timeout — if bridge never becomes ready
      if (!this.readyTimeout) {
        this.readyTimeout = setTimeout(() => {
          this.readyTimeout = null;
          const pending = this.readyResolvers.splice(0);
          for (const r of pending) {
            // Resolve anyway so tools don't hang forever — they'll get undefined from exec
            r();
          }
        }, timeoutMs);
      }
    });
  }

  /** Back-compat: returns true when state is READY. */
  isInjected(): boolean {
    return this._state === 'READY';
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                         */
  /* ------------------------------------------------------------------ */

  attach(webview: WebviewLike): void {
    this.detach();
    this.webview = webview;

    this.boundDomReady = () => {
      void this.handleDomReady();
    };
    this.boundIpcMessage = (event: unknown) => {
      this.handleIpcMessage(event);
    };

    webview.addEventListener('dom-ready', this.boundDomReady);
    webview.addEventListener('ipc-message', this.boundIpcMessage);

    this.setState('ATTACHED');
  }

  detach(): void {
    if (!this.webview) return;

    if (this.boundDomReady && this.webview.removeEventListener) {
      this.webview.removeEventListener('dom-ready', this.boundDomReady);
    }
    if (this.boundIpcMessage && this.webview.removeEventListener) {
      this.webview.removeEventListener('ipc-message', this.boundIpcMessage);
    }

    this.webview = null;
    this.boundDomReady = null;
    this.boundIpcMessage = null;
    this.lastInjectedForUrl = '';

    // Reject any pending waiters
    const pending = this.readyResolvers.splice(0);
    for (const r of pending) r(); // resolve to unblock, exec will return undefined
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    this.setState('DETACHED');
  }

  /* ------------------------------------------------------------------ */
  /*  Event system                                                      */
  /* ------------------------------------------------------------------ */

  on<K extends keyof HostBridgeEventMap>(event: K, handler: EventHandler<K>): () => void {
    const bucket = (this.listeners[event] || new Set());
    bucket.add(handler);
    this.listeners[event] = bucket as (typeof this.listeners)[K];
    return () => this.off(event, handler);
  }

  off<K extends keyof HostBridgeEventMap>(event: K, handler: EventHandler<K>): void {
    const bucket = this.listeners[event];
    bucket?.delete(handler);
  }

  private emit<K extends keyof HostBridgeEventMap>(event: K, payload: HostBridgeEventMap[K]): void {
    const bucket = this.listeners[event];
    if (!bucket) return;
    for (const handler of bucket) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`${ LOG_PREFIX } emit listener error`, { event: String(event), error });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Host → Guest commands (all auto-wait for READY)                   */
  /* ------------------------------------------------------------------ */

  async getActionableMarkdown(): Promise<string> {
    return String(await this.execWhenReady('window.sullaBridge.getActionableMarkdown()') || '');
  }

  async click(handle: string): Promise<boolean> {
    const safe = JSON.stringify(handle);
    const raw = await this.execWhenReady(`window.sullaBridge.click(${ safe })`);
    return !!raw;
  }

  async setValue(handle: string, value: string): Promise<boolean> {
    const safeHandle = JSON.stringify(handle);
    const safeValue = JSON.stringify(value);
    return !!(await this.execWhenReady(`window.sullaBridge.setValue(${ safeHandle }, ${ safeValue })`));
  }

  async pressKey(key: string, handle?: string): Promise<boolean> {
    const safeKey = JSON.stringify(key);
    const safeHandle = handle ? JSON.stringify(handle) : 'undefined';

    await this.execWhenReady(`window.sullaBridge.focusElement(${ safeHandle })`);

    if (this.webview) {
      try {
        const el = this.webview as unknown as HTMLElement;
        if (typeof el.focus === 'function') el.focus();
      } catch { /* best effort */ }
    }

    try {
      const { ipcRenderer } = require('electron');
      await ipcRenderer.invoke('browser-tab:send-input-event', { key, type: 'keyDown' });
      if (key.length === 1 || key === 'Enter' || key === 'Space' || key === 'Tab') {
        await ipcRenderer.invoke('browser-tab:send-input-event', { key, type: 'char' });
      }
      await ipcRenderer.invoke('browser-tab:send-input-event', { key, type: 'keyUp' });
      return true;
    } catch (err) {
      console.warn(`${ LOG_PREFIX } pressKey: trusted input failed, falling back to synthetic`, err);
      return !!(await this.exec(`window.sullaBridge.pressKey(${ safeKey }, ${ safeHandle })`));
    }
  }

  async getFormValues(): Promise<Record<string, string>> {
    const result = await this.execWhenReady('window.sullaBridge.getFormValues()');
    return (result && typeof result === 'object' && !Array.isArray(result))
      ? result as Record<string, string>
      : {};
  }

  async waitForSelector(selector: string, timeoutMs = 5000): Promise<boolean> {
    const safeSel = JSON.stringify(selector);
    return !!(await this.execWhenReady(`window.sullaBridge.waitForSelector(${ safeSel }, ${ timeoutMs })`));
  }

  async scrollTo(selector: string): Promise<boolean> {
    const safe = JSON.stringify(selector);
    return !!(await this.execWhenReady(`window.sullaBridge.scrollTo(${ safe })`));
  }

  async getPageText(): Promise<string> {
    return String(await this.execWhenReady('window.sullaBridge.getPageText()') || '');
  }

  async getReaderContent(maxChars?: number): Promise<{
    title: string; url: string; content: string;
    contentLength: number; truncated: boolean;
  } | null> {
    const arg = typeof maxChars === 'number' ? String(maxChars) : '';
    const result = await this.execWhenReady(`window.sullaBridge.getReaderContent(${ arg })`);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      return {
        title:         String(r.title || ''),
        url:           String(r.url || ''),
        content:       String(r.content || ''),
        contentLength: Number(r.contentLength) || 0,
        truncated:     r.truncated === true,
      };
    }
    return null;
  }

  /** getPageTitle and getPageUrl don't need sullaBridge — they use native JS. */
  async getPageTitle(): Promise<string> {
    return String(await this.exec('document.title') || '');
  }

  async getPageUrl(): Promise<string> {
    return String(await this.exec('location.href') || '');
  }

  async getPageHtml(): Promise<string> {
    return String(await this.exec('document.documentElement.outerHTML') || '');
  }

  async execInPage(code: string): Promise<unknown> {
    return await this.exec(code);
  }

  async getScrollInfo(): Promise<{
    scrollY: number; scrollHeight: number; viewportHeight: number;
    percent: number; atTop: boolean; atBottom: boolean;
    moreBelow: boolean; moreAbove: boolean;
  }> {
    const result = await this.execWhenReady('window.sullaBridge.getScrollInfo()');
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      return {
        scrollY:        Number(r.scrollY) || 0,
        scrollHeight:   Number(r.scrollHeight) || 0,
        viewportHeight: Number(r.viewportHeight) || 0,
        percent:        Number(r.percent) || 0,
        atTop:          r.atTop === true,
        atBottom:       r.atBottom === true,
        moreBelow:      r.moreBelow === true,
        moreAbove:      r.moreAbove === true,
      };
    }
    return { scrollY: 0, scrollHeight: 0, viewportHeight: 0, percent: 0, atTop: true, atBottom: true, moreBelow: false, moreAbove: false };
  }

  async scrollAndCapture(direction?: string): Promise<{
    newContent: string; scrollInfo: Record<string, unknown>; noNewContent: boolean;
  }> {
    const dir = JSON.stringify(direction || 'down');
    const result = await this.execWhenReady(`window.sullaBridge.scrollAndCapture(${ dir })`);
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      return {
        newContent:   String(r.newContent || ''),
        scrollInfo:   (r.scrollInfo && typeof r.scrollInfo === 'object') ? r.scrollInfo as Record<string, unknown> : {},
        noNewContent: r.noNewContent === true,
      };
    }
    return { newContent: '', scrollInfo: {}, noNewContent: true };
  }

  async scrollToTop(): Promise<Record<string, unknown>> {
    const result = await this.execWhenReady('window.sullaBridge.scrollToTop()');
    if (result && typeof result === 'object') return result as Record<string, unknown>;
    return {};
  }

  async searchInPage(query: string): Promise<{
    matches: Array<{ index: number; context: string }>; total: number; query: string;
  }> {
    const safe = JSON.stringify(query);
    const result = await this.execWhenReady(`window.sullaBridge.searchInPage(${ safe })`);
    if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      return {
        matches: Array.isArray(r.matches) ? r.matches as Array<{ index: number; context: string }> : [],
        total:   Number(r.total) || 0,
        query:   String(r.query || query),
      };
    }
    return { matches: [], total: 0, query };
  }

  /* ------------------------------------------------------------------ */
  /*  Manual injection (for non-webview iframes via postMessage)        */
  /* ------------------------------------------------------------------ */

  async injectNow(): Promise<void> {
    if (!this.webview) return;
    await this.webview.executeJavaScript(buildGuestBridgeScript(), false);
    const url = this.getCurrentUrl();
    this.lastInjectedForUrl = url;
    this.setState('READY');
    console.log(`${ LOG_PREFIX } manual inject done`, { url });
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  /** Execute JS in guest. Does NOT wait for READY — use execWhenReady for sullaBridge calls. */
  private async exec(code: string): Promise<unknown> {
    if (!this.webview) {
      return undefined;
    }
    try {
      return await this.webview.executeJavaScript(code, true);
    } catch (error) {
      console.error(`${ LOG_PREFIX } exec: ERROR`, { code: code.slice(0, 200), error });
      return undefined;
    }
  }

  /** Wait for READY state, then execute JS. Commands auto-queue here. */
  private async execWhenReady(code: string): Promise<unknown> {
    try {
      await this.whenReady();
    } catch {
      return undefined; // detached
    }
    const result = await this.exec(code);

    // If sullaBridge returned undefined for a bridge method call, it's likely
    // dead from navigation. Force reinject and retry.
    if (result === undefined && code.includes('sullaBridge.') && this._state === 'READY') {
      console.log(`${ LOG_PREFIX } dead bridge detected, forcing reinject`);
      this.lastInjectedForUrl = ''; // allow reinjection
      this.setState('NAVIGATING');
      // Force reinject now — don't wait for dom-ready which may have already fired
      if (this.webview) {
        this.setState('INJECTING');
        await this.delay(300); // brief delay for page to settle
        if (this.webview) {
          // Clear the guard flag so the guest script runs fresh and emits sulla:injected
          await this.webview.executeJavaScript('window.__sullaBridgeInjected = false', false);
          await this.webview.executeJavaScript(buildGuestBridgeScript(), false);
          this.lastInjectedForUrl = this.getCurrentUrl();
          // sulla:injected event will transition to READY
        }
      }
      // Wait for READY then retry
      try {
        await this.whenReady();
        return await this.exec(code);
      } catch {
        return undefined;
      }
    }

    return result;
  }

  private async handleDomReady(): Promise<void> {
    if (!this.webview) return;

    const currentUrl = this.getCurrentUrl();
    if (this.lastInjectedForUrl === currentUrl && this._state === 'READY') return;

    // New URL means navigation happened — queue any in-flight commands
    if (this._state === 'READY') {
      this.setState('NAVIGATING');
    }
    this.setState('INJECTING');

    await this.delay(this.injectDelayMs);
    if (!this.webview) return;

    console.log(`${ LOG_PREFIX } injecting guest bridge`, { url: currentUrl });
    // Clear the guard flag so the guest script runs fresh on the new page
    await this.webview.executeJavaScript('window.__sullaBridgeInjected = false', false);
    await this.webview.executeJavaScript(buildGuestBridgeScript(), false);
    this.lastInjectedForUrl = currentUrl;
    // Don't set READY here — wait for sulla:injected event from guest
  }

  private handleIpcMessage(event: unknown): void {
    const payload = this.parseBridgePayload(event);
    if (!payload) return;

    const { type, data } = payload;
    const rec = this.asRecord(data);

    if (type === 'sulla:injected') {
      // Guest bridge is loaded and ready — transition to READY
      this.setState('READY');
      this.emit('injected', {
        url:       String(rec.url || ''),
        title:     String(rec.title || ''),
        timestamp: this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:routeChanged') {
      // Page is navigating — bridge will be destroyed and reinjected
      if (this._state === 'READY') {
        this.setState('NAVIGATING');
      }
      this.emit('routeChanged', {
        url:       String(rec.url || ''),
        path:      String(rec.path || ''),
        title:     String(rec.title || ''),
        timestamp: this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:click') {
      this.emit('click', {
        text:       String(rec.text || ''),
        tagName:    String(rec.tagName || ''),
        id:         String(rec.id || ''),
        name:       String(rec.name || ''),
        dataTestId: String(rec.dataTestId || ''),
        disabled:   rec.disabled === true,
        timestamp:  this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:dialog') {
      this.emit('dialog', {
        dialogType:   (rec.dialogType === 'confirm' ? 'confirm' : rec.dialogType === 'prompt' ? 'prompt' : 'alert'),
        message:      String(rec.message || ''),
        defaultValue: typeof rec.defaultValue === 'string' ? rec.defaultValue : undefined,
        url:          String(rec.url || ''),
        title:        String(rec.title || ''),
        timestamp:    this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:pageContent') {
      this.emit('pageContent', {
        title:         String(rec.title || ''),
        url:           String(rec.url || ''),
        content:       String(rec.content || ''),
        contentLength: Number(rec.contentLength) || 0,
        truncated:     rec.truncated === true,
        timestamp:     this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:contentAdded') {
      this.emit('contentAdded', {
        content:       String(rec.content || ''),
        contentLength: Number(rec.contentLength) || 0,
        url:           String(rec.url || ''),
        title:         String(rec.title || ''),
        timestamp:     this.asTimestamp(rec.timestamp),
      });
    }
  }

  private parseBridgePayload(event: unknown): { type: string; data: unknown } | null {
    const e = this.asRecord(event);
    const channel = typeof e.channel === 'string' ? e.channel : '';
    const args = Array.isArray(e.args) ? e.args : [];

    if (channel === BRIDGE_CHANNEL && args.length > 0) {
      const first = this.asRecord(args[0]);
      const type = typeof first.type === 'string' ? first.type : '';
      if (type) return { type, data: first.data };
    }

    return null;
  }

  private getCurrentUrl(): string {
    if (!this.webview) return '';
    try {
      if (typeof this.webview.getURL === 'function') {
        return String(this.webview.getURL() || '').trim();
      }
    } catch { /* ignore */ }
    return String(this.webview.src || '').trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private asRecord(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as JsonRecord;
  }

  private asTimestamp(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  }
}
