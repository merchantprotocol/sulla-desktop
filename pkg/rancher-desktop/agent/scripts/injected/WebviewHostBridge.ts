/**
 * WebviewHostBridge.ts
 *
 * Host-side bridge that communicates with the guest preload script
 * (`window.sullaBridge`) injected into any website webview or iframe.
 *
 * Usage:
 *   const bridge = new WebviewHostBridge();
 *   bridge.attach(webviewElement);
 *   const markdown = await bridge.getActionableMarkdown();
 *   await bridge.click('@btn-save');
 *   await bridge.setValue('@field-email', 'test@example.com');
 */

import { buildGuestBridgeScript, BRIDGE_CHANNEL } from './GuestBridgePreload';

type JsonRecord = Record<string, unknown>;

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
  domChange: {
    summary:   string;
    url:       string;
    title:     string;
    timestamp: number;
  };
  dialog: {
    dialogType:    'alert' | 'confirm' | 'prompt';
    message:       string;
    defaultValue?: string;
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

export class WebviewHostBridge {
  private readonly injectDelayMs: number;
  private readonly listeners: {
    [K in keyof HostBridgeEventMap]?: Set<EventHandler<K>>;
  } = {};

  private webview:         WebviewLike | null = null;
  private boundDomReady:   ((event: unknown) => void) | null = null;
  private boundIpcMessage: ((event: unknown) => void) | null = null;
  private lastInjectedForUrl = '';
  private injected = false;

  constructor(config: HostBridgeConfig = {}) {
    this.injectDelayMs = config.injectDelayMs ?? 500;
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

    console.log(`${ LOG_PREFIX } attached`);
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
    this.injected = false;
    console.log(`${ LOG_PREFIX } detached`);
  }

  isInjected(): boolean {
    return this.injected;
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
  /*  Host → Guest commands                                             */
  /* ------------------------------------------------------------------ */

  async getActionableMarkdown(): Promise<string> {
    return String(await this.exec('window.sullaBridge.getActionableMarkdown()') || '');
  }

  async click(handle: string): Promise<boolean> {
    const safe = JSON.stringify(handle);
    console.log(`${ LOG_PREFIX } click: invoking guest`, { handle, injected: this.injected, hasWebview: !!this.webview });
    const raw = await this.exec(`window.sullaBridge.click(${ safe })`);
    console.log(`${ LOG_PREFIX } click: guest returned`, { raw, type: typeof raw });
    return !!raw;
  }

  async setValue(handle: string, value: string): Promise<boolean> {
    const safeHandle = JSON.stringify(handle);
    const safeValue = JSON.stringify(value);
    return !!(await this.exec(`window.sullaBridge.setValue(${ safeHandle }, ${ safeValue })`));
  }

  async getFormValues(): Promise<Record<string, string>> {
    const result = await this.exec('window.sullaBridge.getFormValues()');
    return (result && typeof result === 'object' && !Array.isArray(result))
      ? result as Record<string, string>
      : {};
  }

  async waitForSelector(selector: string, timeoutMs = 5000): Promise<boolean> {
    const safeSel = JSON.stringify(selector);
    return !!(await this.exec(`window.sullaBridge.waitForSelector(${ safeSel }, ${ timeoutMs })`));
  }

  async scrollTo(selector: string): Promise<boolean> {
    const safe = JSON.stringify(selector);
    return !!(await this.exec(`window.sullaBridge.scrollTo(${ safe })`));
  }

  async getPageText(): Promise<string> {
    return String(await this.exec('window.sullaBridge.getPageText()') || '');
  }

  async getPageTitle(): Promise<string> {
    return String(await this.exec('document.title') || '');
  }

  async getPageUrl(): Promise<string> {
    return String(await this.exec('location.href') || '');
  }

  /* ------------------------------------------------------------------ */
  /*  Manual injection (for non-webview iframes via postMessage)        */
  /* ------------------------------------------------------------------ */

  async injectNow(): Promise<void> {
    if (!this.webview) return;
    await this.webview.executeJavaScript(buildGuestBridgeScript(), false);
    this.injected = true;
    const url = this.getCurrentUrl();
    this.lastInjectedForUrl = url;
    console.log(`${ LOG_PREFIX } manual inject done`, { url });
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  private async exec(code: string): Promise<unknown> {
    if (!this.webview) {
      console.warn(`${ LOG_PREFIX } exec: no webview attached`);
      return undefined;
    }
    console.log(`${ LOG_PREFIX } exec: running`, { code: code.slice(0, 200), injected: this.injected });
    try {
      const result = await this.webview.executeJavaScript(code, true);
      console.log(`${ LOG_PREFIX } exec: success`, { resultType: typeof result, result: typeof result === 'string' ? result.slice(0, 200) : result });
      return result;
    } catch (error) {
      console.error(`${ LOG_PREFIX } exec: ERROR`, { code: code.slice(0, 200), error });
      return undefined;
    }
  }

  private async handleDomReady(): Promise<void> {
    if (!this.webview) return;

    const currentUrl = this.getCurrentUrl();
    if (this.lastInjectedForUrl === currentUrl) return;

    await this.delay(this.injectDelayMs);
    if (!this.webview) return;

    console.log(`${ LOG_PREFIX } injecting guest bridge`, { url: currentUrl });
    await this.webview.executeJavaScript(buildGuestBridgeScript(), false);
    this.injected = true;
    this.lastInjectedForUrl = currentUrl;
  }

  private handleIpcMessage(event: unknown): void {
    const payload = this.parseBridgePayload(event);
    if (!payload) return;

    const { type, data } = payload;
    const rec = this.asRecord(data);

    if (type === 'sulla:injected') {
      this.emit('injected', {
        url:       String(rec.url || ''),
        title:     String(rec.title || ''),
        timestamp: this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:routeChanged') {
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

    if (type === 'sulla:domChange') {
      this.emit('domChange', {
        summary:   String(rec.summary || ''),
        url:       String(rec.url || ''),
        title:     String(rec.title || ''),
        timestamp: this.asTimestamp(rec.timestamp),
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
