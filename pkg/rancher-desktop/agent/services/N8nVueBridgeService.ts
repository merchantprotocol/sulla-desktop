type JsonRecord = Record<string, unknown>;

export interface N8nRouteSnapshot {
  name?:     string;
  path?:     string;
  fullPath?: string;
  params?:   JsonRecord;
  query?:    JsonRecord;
  title?:    string;
  timestamp: number;
}

export interface N8nSocketEventSnapshot {
  type:      string;
  channel?:  string;
  pushRef?:  string;
  payload:   unknown;
  timestamp: number;
}

export interface N8nClickSnapshot {
  text?:       string;
  classList:   string[];
  dataTestId?: string;
  disabled:    boolean;
  timestamp:   number;
}

export interface N8nVueBridgeEventMap {
  injected:     { url: string; timestamp: number };
  routeChanged: N8nRouteSnapshot;
  socketEvent:  N8nSocketEventSnapshot;
  click:        N8nClickSnapshot;
  bridgeError:  { message: string; raw?: unknown; timestamp: number };
}

type EventHandler<K extends keyof N8nVueBridgeEventMap> = (payload: N8nVueBridgeEventMap[K]) => void;

export interface N8nWebviewLike {
  src?:                 string;
  getURL?:              () => string;
  executeJavaScript:    (code: string, userGesture?: boolean) => Promise<unknown>;
  addEventListener:     (event: 'dom-ready' | 'ipc-message', listener: (event: unknown) => void) => void;
  removeEventListener?: (event: 'dom-ready' | 'ipc-message', listener: (event: unknown) => void) => void;
}

export interface N8nVueBridgeConfig {
  n8nPort?:       number;
  injectDelayMs?: number;
}

const BRIDGE_CHANNEL = 'sulla:n8n:bridge';
const LOG_PREFIX = '[SULLA_N8N_VUE_BRIDGE]';

export class N8nVueBridgeService {
  private readonly n8nPort:       number;
  private readonly injectDelayMs: number;
  private readonly listeners: {
    [K in keyof N8nVueBridgeEventMap]?: Set<EventHandler<K>>;
  } = {};

  private webview:         N8nWebviewLike | null = null;
  private boundDomReady:   ((event: unknown) => void) | null = null;
  private boundIpcMessage: ((event: unknown) => void) | null = null;
  private lastInjectedForUrl = '';
  private readonly createdAt = Date.now();
  private themeMode:       'light' | 'dark' | null = null;

  constructor(config: N8nVueBridgeConfig = {}) {
    this.n8nPort = config.n8nPort ?? 30119;
    this.injectDelayMs = config.injectDelayMs ?? 700;
    console.log(`${ LOG_PREFIX } constructor`, {
      n8nPort:       this.n8nPort,
      injectDelayMs: this.injectDelayMs,
      createdAt:     this.createdAt,
    });
    this.markInitialized('constructor');
  }

  markInitialized(source: string): void {
    console.log(`${ LOG_PREFIX } initialized`, {
      source,
      createdAt:                 this.createdAt,
      hasAttachedWebview:        !!this.webview,
      isWaitingForWebviewAttach: !this.webview,
      lastInjectedForUrl:        this.lastInjectedForUrl,
    });
  }

  attach(webview: N8nWebviewLike): void {
    console.log(`${ LOG_PREFIX } attach:start`);
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
    console.log(`${ LOG_PREFIX } attach:done`, {
      hasGetURL: typeof webview.getURL === 'function',
      src:       typeof webview.src === 'string' ? webview.src : '',
    });
  }

  detach(): void {
    if (!this.webview) {
      console.log(`${ LOG_PREFIX } detach:skip_no_webview`);
      return;
    }

    console.log(`${ LOG_PREFIX } detach:start`);

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
    console.log(`${ LOG_PREFIX } detach:done`);
  }

  on<K extends keyof N8nVueBridgeEventMap>(event: K, handler: EventHandler<K>): () => void {
    const bucket = (this.listeners[event] || new Set());
    bucket.add(handler);
    this.listeners[event] = bucket as (typeof this.listeners)[K];

    console.log(`${ LOG_PREFIX } on`, {
      event,
      listenerCount: bucket.size,
    });

    return () => this.off(event, handler);
  }

  off<K extends keyof N8nVueBridgeEventMap>(event: K, handler: EventHandler<K>): void {
    const bucket = this.listeners[event];
    const before = bucket?.size || 0;
    bucket?.delete(handler);
    console.log(`${ LOG_PREFIX } off`, {
      event,
      listenerCountBefore: before,
      listenerCountAfter:  bucket?.size || 0,
    });
  }

  async navigateTo(page: string): Promise<void> {
    if (!this.webview) {
      console.log(`${ LOG_PREFIX } navigateTo:skip_no_webview`, { page });
      return;
    }

    console.log(`${ LOG_PREFIX } navigateTo:start`, { page });

    const pageJson = JSON.stringify(page);
    const navigationResult = await this.webview.executeJavaScript(`
      (() => {
        const targetPage = ${ pageJson };
        const router = window.__VUE_APP__?.config?.globalProperties?.$router || window.vueRouter || null;
        if (router && typeof router.push === 'function') {
          router.push(targetPage);
          return true;
        }

        const link = document.querySelector('a[href="' + targetPage + '"]');
        if (link && typeof link.click === 'function') {
          link.click();
          return true;
        }

        return false;
      })();
    `, true);

    console.log(`${ LOG_PREFIX } navigateTo:done`, {
      page,
      navigationResult,
    });
  }

  async clickButton(textOrId: string): Promise<void> {
    if (!this.webview) {
      console.log(`${ LOG_PREFIX } clickButton:skip_no_webview`, { textOrId });
      return;
    }

    console.log(`${ LOG_PREFIX } clickButton:start`, { textOrId });

    const selectorValue = JSON.stringify(textOrId);
    const clickResult = await this.webview.executeJavaScript(`
      (() => {
        const target = ${ selectorValue };
        const byDataTestId = document.querySelector('[data-test-id="' + target + '"]');
        if (byDataTestId && typeof byDataTestId.click === 'function') {
          byDataTestId.click();
          return true;
        }

        const candidate = Array.from(document.querySelectorAll('button, [role="button"]')).find((el) => {
          const text = String(el?.textContent || '').trim();
          return text === target;
        });

        if (candidate && typeof (candidate as HTMLElement).click === 'function') {
          (candidate as HTMLElement).click();
          return true;
        }

        return false;
      })();
    `, true);

    console.log(`${ LOG_PREFIX } clickButton:done`, {
      textOrId,
      clickResult,
    });
  }

  setDarkMode(): void {
    this.setThemeMode('dark');
  }

  setLightMode(): void {
    this.setThemeMode('light');
  }

  setThemeMode(mode: 'light' | 'dark'): void {
    this.themeMode = mode;
    console.log(`${ LOG_PREFIX } setThemeMode`, { mode, hasWebview: !!this.webview });
    void this.applyThemeMode(mode);
  }

  private emit<K extends keyof N8nVueBridgeEventMap>(event: K, payload: N8nVueBridgeEventMap[K]): void {
    const bucket = this.listeners[event];
    if (!bucket) {
      console.log(`${ LOG_PREFIX } emit:skip_no_listeners`, { event });
      return;
    }

    console.log(`${ LOG_PREFIX } emit`, {
      event,
      listenerCount: bucket.size,
      payload,
    });

    for (const handler of bucket) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`${ LOG_PREFIX } emit:listener_failed`, {
          event: String(event),
          error,
        });
      }
    }
  }

  private async handleDomReady(): Promise<void> {
    if (!this.webview) {
      console.log(`${ LOG_PREFIX } handleDomReady:skip_no_webview`);
      return;
    }

    const currentUrl = this.getCurrentWebviewUrl(this.webview);
    console.log(`${ LOG_PREFIX } handleDomReady:url`, { currentUrl });
    if (!this.isN8nAssetUrl(currentUrl)) {
      console.log(`${ LOG_PREFIX } handleDomReady:skip_non_n8n`, { currentUrl });
      return;
    }

    if (this.lastInjectedForUrl === currentUrl) {
      console.log(`${ LOG_PREFIX } handleDomReady:skip_already_injected`, { currentUrl });
      return;
    }

    await this.delay(this.injectDelayMs);
    if (!this.webview) {
      console.log(`${ LOG_PREFIX } handleDomReady:skip_webview_disposed_after_delay`, { currentUrl });
      return;
    }

    console.log(`${ LOG_PREFIX } handleDomReady:inject:start`, {
      currentUrl,
      injectDelayMs: this.injectDelayMs,
    });
    await this.webview.executeJavaScript(this.buildInjectScript(), false);
    this.lastInjectedForUrl = currentUrl;

    if (this.themeMode) {
      await this.applyThemeMode(this.themeMode);
    }

    console.log(`${ LOG_PREFIX } handleDomReady:inject:done`, { currentUrl });
    this.emit('injected', { url: currentUrl, timestamp: Date.now() });
  }

  private async applyThemeMode(mode: 'light' | 'dark'): Promise<void> {
    if (!this.webview) {
      return;
    }

    const isDark = mode === 'dark';
    const script = `
      (() => {
        const mode = ${ JSON.stringify(mode) };
        const isDark = ${ isDark ? 'true' : 'false' };
        const html = document.documentElement;
        const body = document.body;

        if (html) {
          html.classList.toggle('dark', isDark);
          html.classList.toggle('light', !isDark);
          html.setAttribute('data-theme', mode);
          html.style.colorScheme = mode;
        }

        if (body) {
          body.classList.toggle('dark', isDark);
          body.classList.toggle('light', !isDark);
          body.setAttribute('data-theme', mode);
          body.style.colorScheme = mode;
        }

        try {
          localStorage.setItem('theme', mode);
          localStorage.setItem('n8n-theme', mode);
          localStorage.setItem('ui-theme', mode);
        } catch {}

        return { ok: true, mode };
      })();
    `;

    try {
      const result = await this.webview.executeJavaScript(script, true);
      console.log(`${ LOG_PREFIX } applyThemeMode:done`, { mode, result });
    } catch (error) {
      console.warn(`${ LOG_PREFIX } applyThemeMode:failed`, { mode, error });
    }
  }

  private handleIpcMessage(event: unknown): void {
    console.log(`${ LOG_PREFIX } ipc:received`, { event });
    const payload = this.parseBridgePayload(event);
    if (!payload) {
      console.log(`${ LOG_PREFIX } ipc:skip_unparsed`);
      return;
    }

    const { type, data } = payload;
    console.log(`${ LOG_PREFIX } ipc:parsed`, { type, data });

    if (type === 'sulla:routeChanged') {
      const rec = this.asRecord(data);
      this.emit('routeChanged', {
        name:      typeof rec.name === 'string' ? rec.name : undefined,
        path:      typeof rec.path === 'string' ? rec.path : undefined,
        fullPath:  typeof rec.fullPath === 'string' ? rec.fullPath : undefined,
        params:    this.asRecord(rec.params),
        query:     this.asRecord(rec.query),
        title:     typeof rec.title === 'string' ? rec.title : undefined,
        timestamp: this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:socketEvent') {
      const rec = this.asRecord(data);
      this.emit('socketEvent', {
        type:      String(rec.type || 'push'),
        channel:   typeof rec.channel === 'string' ? rec.channel : undefined,
        pushRef:   typeof rec.pushRef === 'string' ? rec.pushRef : undefined,
        payload:   rec.payload,
        timestamp: this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:click') {
      const rec = this.asRecord(data);
      const classList = Array.isArray(rec.classList)
        ? rec.classList.filter((entry): entry is string => typeof entry === 'string')
        : [];

      this.emit('click', {
        text:       typeof rec.text === 'string' ? rec.text : undefined,
        classList,
        dataTestId: typeof rec.dataTestId === 'string' ? rec.dataTestId : undefined,
        disabled:   rec.disabled === true,
        timestamp:  this.asTimestamp(rec.timestamp),
      });
      return;
    }

    if (type === 'sulla:bridgeError') {
      const rec = this.asRecord(data);
      this.emit('bridgeError', {
        message:   typeof rec.message === 'string' ? rec.message : 'Unknown n8n bridge error',
        raw:       rec.raw,
        timestamp: this.asTimestamp(rec.timestamp),
      });
      return;
    }

    console.log(`${ LOG_PREFIX } ipc:skip_unknown_type`, { type, data });
  }

  private parseBridgePayload(event: unknown): { type: string; data: unknown } | null {
    const e = this.asRecord(event);
    const channel = typeof e.channel === 'string' ? e.channel : '';
    const args = Array.isArray(e.args) ? e.args : [];

    if (channel === BRIDGE_CHANNEL) {
      const firstArg = args[0];
      const first = this.asRecord(firstArg);
      const type = typeof first.type === 'string' ? first.type : '';
      if (type) {
        console.log(`${ LOG_PREFIX } parseBridgePayload:matched_channel`, { type });
        return { type, data: first.data };
      }
    }

    const maybeTypedChannel = this.asRecord((e).channel);
    if (typeof maybeTypedChannel.type === 'string') {
      console.log(`${ LOG_PREFIX } parseBridgePayload:matched_typed_channel`, {
        type: maybeTypedChannel.type,
      });
      return {
        type: maybeTypedChannel.type,
        data: maybeTypedChannel.data,
      };
    }

    console.log(`${ LOG_PREFIX } parseBridgePayload:no_match`, {
      channel,
      argsLength: args.length,
    });

    return null;
  }

  private getCurrentWebviewUrl(webview: N8nWebviewLike): string {
    try {
      if (typeof webview.getURL === 'function') {
        const url = String(webview.getURL() || '').trim();
        console.log(`${ LOG_PREFIX } getCurrentWebviewUrl:getURL`, { url });
        return url;
      }
    } catch {
      // ignore
    }

    const url = String(webview.src || '').trim();
    console.log(`${ LOG_PREFIX } getCurrentWebviewUrl:src`, { url });
    return url;
  }

  private isN8nAssetUrl(rawUrl: string): boolean {
    if (!rawUrl) {
      console.log(`${ LOG_PREFIX } isN8nAssetUrl:false_empty`);
      return false;
    }

    try {
      const parsed = new URL(rawUrl);
      const isMatch = parsed.port === String(this.n8nPort);
      console.log(`${ LOG_PREFIX } isN8nAssetUrl:parsed`, {
        rawUrl,
        parsedPort: parsed.port,
        targetPort: String(this.n8nPort),
        isMatch,
      });
      return isMatch;
    } catch {
      const isMatch = rawUrl.includes(`:${ this.n8nPort }`);
      console.log(`${ LOG_PREFIX } isN8nAssetUrl:fallback`, {
        rawUrl,
        targetPort: String(this.n8nPort),
        isMatch,
      });
      return isMatch;
    }
  }

  private asTimestamp(value: unknown): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    return Date.now();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private asRecord(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as JsonRecord;
  }

  private buildInjectScript(): string {
    return `
      (() => {
        if (window.__sullaN8nBridgeInjected) {
          console.log('${ LOG_PREFIX } injectScript:skip_already_injected');
          return;
        }
        window.__sullaN8nBridgeInjected = true;

        const bridgeState = window.sullaN8nBridge = {
          currentRoute: null,
          lastSocketEvents: [],
          availableActions: [],
        };

        const emitHost = (type, data) => {
          const payload = { type, data };
          try {
            console.log('${ LOG_PREFIX } injectScript:emitHost', payload);
          } catch {}
          try {
            if (window?.electron?.ipcRenderer?.sendToHost) {
              window.electron.ipcRenderer.sendToHost('${ BRIDGE_CHANNEL }', payload);
            } else if (window?.ipcRenderer?.sendToHost) {
              window.ipcRenderer.sendToHost('${ BRIDGE_CHANNEL }', payload);
            }
          } catch {}

          try {
            window.postMessage(payload, '*');
          } catch {}
        };

        const safeRoutePayload = (routeLike) => {
          const route = routeLike || {};
          return {
            name: route.name,
            path: route.path,
            fullPath: route.fullPath,
            params: route.params,
            query: route.query,
            timestamp: Date.now(),
          };
        };

        const observeRoute = () => {
          console.log('${ LOG_PREFIX } injectScript:observeRoute:start');
          try {
            const router = window.__VUE_APP__?.config?.globalProperties?.$router || window.vueRouter || null;
            if (router && typeof router.afterEach === 'function') {
              console.log('${ LOG_PREFIX } injectScript:observeRoute:router_found');
              router.afterEach((to) => {
                bridgeState.currentRoute = safeRoutePayload(to);
                emitHost('sulla:routeChanged', bridgeState.currentRoute);
              });

              const current = typeof router.currentRoute === 'object'
                ? (router.currentRoute?.value || router.currentRoute)
                : null;
              if (current) {
                bridgeState.currentRoute = safeRoutePayload(current);
                emitHost('sulla:routeChanged', bridgeState.currentRoute);
              }
              return;
            }
          } catch {}

          console.log('${ LOG_PREFIX } injectScript:observeRoute:fallback_mode');

          const sendFallbackRoute = () => {
            bridgeState.currentRoute = {
              path: String(window.location.pathname || '') + String(window.location.hash || ''),
              title: document.title,
              timestamp: Date.now(),
            };
            emitHost('sulla:routeChanged', bridgeState.currentRoute);
          };

          sendFallbackRoute();

          const observer = new MutationObserver(() => {
            sendFallbackRoute();
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
          });
        };

        const OriginalWebSocket = window.WebSocket;
        if (typeof OriginalWebSocket === 'function') {
          console.log('${ LOG_PREFIX } injectScript:websocket_hook:enabled');
          const WrappedWebSocket = function(url, protocols) {
            const ws = protocols === undefined
              ? new OriginalWebSocket(url)
              : new OriginalWebSocket(url, protocols);

            ws.addEventListener('message', (e) => {
              try {
                const data = JSON.parse(e.data);
                if (data?.pushRef || data?.type || data?.channel) {
                  const eventPayload = {
                    type: data.type || 'push',
                    channel: data.channel,
                    pushRef: data.pushRef,
                    payload: data,
                    timestamp: Date.now(),
                  };

                  bridgeState.lastSocketEvents.push(eventPayload);
                  if (bridgeState.lastSocketEvents.length > 50) {
                    bridgeState.lastSocketEvents.shift();
                  }
                  emitHost('sulla:socketEvent', eventPayload);
                }
              } catch {}
            });

            return ws;
          };

          WrappedWebSocket.prototype = OriginalWebSocket.prototype;
          Object.defineProperty(WrappedWebSocket, 'name', { value: 'WebSocket' });
          window.WebSocket = WrappedWebSocket;
        }

        if (typeof window.EventSource === 'function') {
          console.log('${ LOG_PREFIX } injectScript:eventsource_hook:enabled');
          const OriginalEventSource = window.EventSource;
          const WrappedEventSource = function(url, configuration) {
            const es = new OriginalEventSource(url, configuration);
            es.addEventListener('message', (e) => {
              try {
                const data = JSON.parse(e.data);
                if (data?.pushRef || data?.type || data?.channel) {
                  const eventPayload = {
                    type: data.type || 'push',
                    channel: data.channel,
                    pushRef: data.pushRef,
                    payload: data,
                    timestamp: Date.now(),
                  };
                  bridgeState.lastSocketEvents.push(eventPayload);
                  if (bridgeState.lastSocketEvents.length > 50) {
                    bridgeState.lastSocketEvents.shift();
                  }
                  emitHost('sulla:socketEvent', eventPayload);
                }
              } catch {}
            });
            return es;
          };

          WrappedEventSource.prototype = OriginalEventSource.prototype;
          Object.defineProperty(WrappedEventSource, 'name', { value: 'EventSource' });
          window.EventSource = WrappedEventSource;
        }

        document.addEventListener('click', (e) => {
          const source = e.target;
          const target = source && typeof source.closest === 'function'
            ? source.closest('button, [role="button"], .btn, a[href], [data-test-id]')
            : null;

          if (!target) {
            return;
          }

          const action = {
            text: target.textContent ? target.textContent.trim() : '',
            classList: Array.from(target.classList || []),
            dataTestId: target.getAttribute('data-test-id') || '',
            disabled: !!target.disabled || target.getAttribute('disabled') !== null,
            timestamp: Date.now(),
          };

          bridgeState.availableActions.push(action);
          if (bridgeState.availableActions.length > 100) {
            bridgeState.availableActions.shift();
          }

          emitHost('sulla:click', action);
        }, true);
        console.log('${ LOG_PREFIX } injectScript:click_listener:enabled');

        observeRoute();
        emitHost('sulla:routeChanged', {
          path: String(window.location.pathname || '') + String(window.location.hash || ''),
          title: document.title,
          timestamp: Date.now(),
        });
        console.log('${ LOG_PREFIX } injectScript:done');
      })();
    `;
  }
}

let n8nVueBridgeServiceInstance: N8nVueBridgeService | null = null;

export function getN8nVueBridgeService(): N8nVueBridgeService {
  if (!n8nVueBridgeServiceInstance) {
    n8nVueBridgeServiceInstance = new N8nVueBridgeService();
    console.log(`${ LOG_PREFIX } singleton:created`);
  } else {
    console.log(`${ LOG_PREFIX } singleton:reused`);
  }

  n8nVueBridgeServiceInstance.markInitialized('getN8nVueBridgeService');

  return n8nVueBridgeServiceInstance;
}
