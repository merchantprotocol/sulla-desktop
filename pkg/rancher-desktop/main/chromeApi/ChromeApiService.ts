/**
 * ChromeApiService — chrome.* API layer for Sulla Desktop.
 *
 * Wraps existing BrowserTabViewManager, HostBridgeProxy, and Electron session
 * APIs behind a Chrome Extensions-compatible interface.  This lets AI agents
 * and (eventually) real Chrome extensions use the same API surface.
 *
 * Architecture:
 * - chrome.tabs    → BrowserTabViewManager + HostBridgeProxy
 * - chrome.scripting → BrowserTabViewManager.executeJavaScript / HostBridgeProxy.execInPage
 * - chrome.cookies → Electron session.cookies
 * - chrome.storage → JSON file on disk (persisted per-partition)
 * - chrome.windows → WebContentsView lifecycle (hidden or attached)
 * - chrome.runtime → EventEmitter-based message bus
 */

import Electron, { WebContentsView, session } from 'electron';
import { EventEmitter } from 'events';

import { BrowserTabViewManager } from '@pkg/window/browserTabViewManager';
import { hostBridgeProxy } from '@pkg/agent/scripts/injected/HostBridgeProxy';
import Logging from '@pkg/utils/logging';

import type {
  ChromeApi,
  ChromeTab,
  TabQueryInfo,
  TabCreateProperties,
  TabUpdateProperties,
  TabChangeInfo,
  ScriptInjection,
  CSSInjection,
  InjectionResult,
  ChromeCookie,
  CookieGetDetails,
  CookieGetAllDetails,
  CookieSetDetails,
  CookieRemoveDetails,
  StorageArea,
  ChromeWindow,
  WindowCreateProperties,
  AlarmCreateInfo,
  ChromeAlarm,
  WebRequestDetails,
  WebRequestHeadersDetails,
  WebRequestResponseDetails,
  ContextMenuCreateProperties,
  ContextMenuUpdateProperties,
  ContextMenuClickInfo,
  NotificationOptions,
  WebNavigationDetails,
  WebNavigationErrorDetails,
  ChromeCommand,
  TtsOptions,
  TtsVoice,
  ActionSetIconDetails,
  ActionSetBadgeDetails,
  ActionSetTitleDetails,
  DownloadOptions,
  DownloadItem,
  DownloadQuery,
  HistoryItem,
  HistoryQuery,
  SidePanelOptions,
  RuntimeMessage,
  ChromeEvent,
  EventListener,
} from './types';

const console = Logging.sulla;
const SESSION_PARTITION = 'persist:sulla-browser';

// ---------------------------------------------------------------------------
// ChromeEvent implementation
// ---------------------------------------------------------------------------

class ChromeEventImpl<T extends unknown[]> implements ChromeEvent<T> {
  private listeners = new Set<EventListener<T>>();

  addListener(callback: EventListener<T>): void {
    this.listeners.add(callback);
  }

  removeListener(callback: EventListener<T>): void {
    this.listeners.delete(callback);
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  emit(...args: T): void {
    for (const listener of this.listeners) {
      try {
        listener(...args);
      } catch (err) {
        console.error('[ChromeApi] Event listener error:', err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Storage implementation (backed by SullaSettingsModel)
// ---------------------------------------------------------------------------

class SullaStorageArea implements StorageArea {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = `chrome.storage.${ prefix }.`;
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    if (keys === null) {
      // Return all keys under this prefix
      return SullaSettingsModel.getByPattern(`${ this.prefix }*`);
    }

    const keyList = typeof keys === 'string' ? [keys] : keys;
    const result: Record<string, unknown> = {};

    for (const key of keyList) {
      const value = await SullaSettingsModel.get(`${ this.prefix }${ key }`);

      if (value !== null) {
        result[key] = value;
      }
    }

    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

    for (const [key, value] of Object.entries(items)) {
      await SullaSettingsModel.set(`${ this.prefix }${ key }`, value, 'json');
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const keyList = typeof keys === 'string' ? [keys] : keys;

    for (const key of keyList) {
      await SullaSettingsModel.delete(`${ this.prefix }${ key }`);
    }
  }
}

// ---------------------------------------------------------------------------
// ChromeApiService
// ---------------------------------------------------------------------------

export class ChromeApiService implements ChromeApi {
  private static instance: ChromeApiService | undefined;

  private tabViewManager: BrowserTabViewManager;

  // Hidden (headless) views not attached to any window
  private hiddenViews = new Map<string, WebContentsView>();
  // Window abstractions (windowId → tab mapping)
  private windowRegistry = new Map<string, { state: 'normal' | 'hidden'; tabId: string }>();

  private windowCounter = 0;
  private tabCounter = 0;

  // Events
  private tabCreatedEvent  = new ChromeEventImpl<[ChromeTab]>();
  private tabRemovedEvent  = new ChromeEventImpl<[string]>();
  private tabUpdatedEvent  = new ChromeEventImpl<[string, TabChangeInfo, ChromeTab]>();
  private alarmEvent       = new ChromeEventImpl<[ChromeAlarm]>();
  private webReqBeforeRequest     = new ChromeEventImpl<[WebRequestDetails]>();
  private webReqBeforeSendHeaders = new ChromeEventImpl<[WebRequestHeadersDetails]>();
  private webReqHeadersReceived   = new ChromeEventImpl<[WebRequestResponseDetails]>();
  private webReqCompleted         = new ChromeEventImpl<[WebRequestResponseDetails]>();
  private webReqErrorOccurred     = new ChromeEventImpl<[WebRequestDetails & { error: string }]>();
  private contextMenuClickedEvent = new ChromeEventImpl<[ContextMenuClickInfo, ChromeTab | null]>();
  private notificationClickedEvent = new ChromeEventImpl<[string]>();
  private notificationClosedEvent  = new ChromeEventImpl<[string, boolean]>();
  private webNavBeforeNavigate = new ChromeEventImpl<[WebNavigationDetails]>();
  private webNavCommitted      = new ChromeEventImpl<[WebNavigationDetails]>();
  private webNavCompleted      = new ChromeEventImpl<[WebNavigationDetails]>();
  private webNavErrorOccurred  = new ChromeEventImpl<[WebNavigationErrorDetails]>();
  private commandEvent         = new ChromeEventImpl<[string]>();
  private ttsEvent             = new ChromeEventImpl<[{ type: 'start' | 'end' | 'error'; charIndex?: number }]>();
  private actionClickedEvent   = new ChromeEventImpl<[ChromeTab]>();
  private downloadCreatedEvent = new ChromeEventImpl<[DownloadItem]>();
  private downloadChangedEvent = new ChromeEventImpl<[{ id: string; state?: { current: string } }]>();
  private historyVisitedEvent  = new ChromeEventImpl<[HistoryItem]>();
  private runtimeMessageEvent  = new ChromeEventImpl<[RuntimeMessage, { id: string }, (response: unknown) => void]>();

  // Alarm timers
  private alarmTimers = new Map<string, { timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>; alarm: ChromeAlarm }>();

  // Context menu items
  private contextMenuItems = new Map<string, ContextMenuCreateProperties>();
  private contextMenuCounter = 0;

  // Notifications
  private activeNotifications = new Map<string, Electron.Notification>();

  // Commands
  private registeredCommands = new Map<string, ChromeCommand>();

  // Downloads
  private activeDownloads = new Map<string, DownloadItem>();
  private downloadCounter = 0;

  // History (in-memory + SullaSettingsModel persistence)
  private historyItems: HistoryItem[] = [];
  private historyLoaded = false;
  private historyCounter = 0;

  // Side panel
  private sidePanelView: WebContentsView | null = null;
  private sidePanelOptions: SidePanelOptions = { path: '', enabled: false };

  // Action state
  private actionState = { icon: '', badgeText: '', badgeColor: '#000', title: '' };

  // Message bus for runtime.sendMessage
  private messageBus = new EventEmitter();

  // Storage
  private localStorage = new SullaStorageArea('local');

  private constructor(tabViewManager: BrowserTabViewManager) {
    this.tabViewManager = tabViewManager;
  }

  static getInstance(tabViewManager?: BrowserTabViewManager): ChromeApiService {
    if (!ChromeApiService.instance) {
      if (!tabViewManager) {
        throw new Error('[ChromeApiService] First call must provide tabViewManager');
      }
      ChromeApiService.instance = new ChromeApiService(tabViewManager);
    }

    return ChromeApiService.instance;
  }

  // =========================================================================
  // chrome.tabs
  // =========================================================================

  tabs = {
    get: async(tabId: string): Promise<ChromeTab | null> => {
      return this.buildTabInfo(tabId);
    },

    query: async(queryInfo: TabQueryInfo): Promise<ChromeTab[]> => {
      const assets = await hostBridgeProxy.getAllAssetInfo();
      const hiddenIds = [...this.hiddenViews.keys()];
      const allTabIds = [
        ...assets.map((a) => a.assetId),
        ...hiddenIds.filter((id) => !assets.some((a) => a.assetId === id)),
      ];

      const tabs: ChromeTab[] = [];

      for (const tabId of allTabIds) {
        const tab = await this.buildTabInfo(tabId);

        if (!tab) continue;

        if (queryInfo.active !== undefined && tab.active !== queryInfo.active) continue;
        if (queryInfo.hidden !== undefined && tab.hidden !== queryInfo.hidden) continue;
        if (queryInfo.url !== undefined && !tab.url.includes(queryInfo.url)) continue;
        if (queryInfo.title !== undefined && !tab.title.includes(queryInfo.title)) continue;

        tabs.push(tab);
      }

      return tabs;
    },

    create: async(props: TabCreateProperties): Promise<ChromeTab> => {
      const tabId = `chrome-tab-${ ++this.tabCounter }-${ Date.now() }`;
      const bounds = { x: 0, y: 0, width: 1280, height: 720 };

      if (props.hidden) {
        // Create a detached WebContentsView — functional but not visible
        const view = new WebContentsView({
          webPreferences: {
            webSecurity:      false,
            contextIsolation: false,
            nodeIntegration:  false,
            partition:        SESSION_PARTITION,
          },
        });

        this.hiddenViews.set(tabId, view);

        view.webContents.loadURL(props.url).catch((err) => {
          console.error(`[ChromeApi] Hidden tab load failed tabId=${ tabId }:`, err);
        });

        console.log(`[ChromeApi] Created hidden tab tabId=${ tabId } url=${ props.url }`);
      } else {
        this.tabViewManager.createView(tabId, props.url, bounds);

        if (props.active !== false) {
          this.tabViewManager.showView(tabId);
        }
      }

      const tab = await this.buildTabInfo(tabId) ?? {
        id: tabId, url: props.url, title: '', active: !!props.active, status: 'loading' as const, hidden: !!props.hidden,
      };

      this.tabCreatedEvent.emit(tab);

      return tab;
    },

    remove: async(tabId: string): Promise<void> => {
      if (this.hiddenViews.has(tabId)) {
        const view = this.hiddenViews.get(tabId)!;

        (view.webContents as any).close?.();
        this.hiddenViews.delete(tabId);
        console.log(`[ChromeApi] Removed hidden tab tabId=${ tabId }`);
      } else {
        this.tabViewManager.destroyView(tabId);
      }

      this.tabRemovedEvent.emit(tabId);
    },

    update: async(tabId: string, props: TabUpdateProperties): Promise<ChromeTab | null> => {
      if (props.url) {
        const hiddenView = this.hiddenViews.get(tabId);

        if (hiddenView) {
          hiddenView.webContents.loadURL(props.url).catch((err) => {
            console.error(`[ChromeApi] Hidden tab navigate failed tabId=${ tabId }:`, err);
          });
        } else {
          this.tabViewManager.navigateTo(tabId, props.url);
        }
      }

      if (props.active === true && !this.hiddenViews.has(tabId)) {
        this.tabViewManager.showView(tabId);
      } else if (props.active === false && !this.hiddenViews.has(tabId)) {
        this.tabViewManager.hideView(tabId);
      }

      const tab = await this.buildTabInfo(tabId);

      if (tab) {
        this.tabUpdatedEvent.emit(tabId, { url: props.url, status: tab.status }, tab);
      }

      return tab;
    },

    reload: async(tabId: string): Promise<void> => {
      const hiddenView = this.hiddenViews.get(tabId);

      if (hiddenView) {
        hiddenView.webContents.reload();
      } else {
        this.tabViewManager.reload(tabId);
      }
    },

    goBack: async(tabId: string): Promise<void> => {
      const hiddenView = this.hiddenViews.get(tabId);

      if (hiddenView) {
        hiddenView.webContents.goBack();
      } else {
        this.tabViewManager.goBack(tabId);
      }
    },

    goForward: async(tabId: string): Promise<void> => {
      const hiddenView = this.hiddenViews.get(tabId);

      if (hiddenView) {
        hiddenView.webContents.goForward();
      } else {
        this.tabViewManager.goForward(tabId);
      }
    },

    onCreated:  this.tabCreatedEvent as ChromeEvent<[ChromeTab]>,
    onRemoved:  this.tabRemovedEvent as ChromeEvent<[string]>,
    onUpdated:  this.tabUpdatedEvent as ChromeEvent<[string, TabChangeInfo, ChromeTab]>,
  };

  // =========================================================================
  // chrome.scripting
  // =========================================================================

  scripting = {
    executeScript: async(injection: ScriptInjection): Promise<InjectionResult[]> => {
      const { tabId } = injection.target;
      let code: string;

      if (injection.func) {
        const args = injection.args ? JSON.stringify(injection.args).slice(1, -1) : '';

        code = `(${ injection.func.toString() })(${ args })`;
      } else if (injection.code) {
        code = injection.code;
      } else {
        throw new Error('[ChromeApi] executeScript requires func or code');
      }

      let result: unknown;
      const hiddenView = this.hiddenViews.get(tabId);

      if (hiddenView) {
        result = await hiddenView.webContents.executeJavaScript(code, true);
      } else {
        result = await this.tabViewManager.executeJavaScript(tabId, code);
      }

      return [{ result }];
    },

    insertCSS: async(injection: CSSInjection): Promise<void> => {
      const { tabId } = injection.target;
      const code = `(() => {
        const style = document.createElement('style');
        style.textContent = ${ JSON.stringify(injection.css) };
        document.head.appendChild(style);
      })()`;

      const hiddenView = this.hiddenViews.get(tabId);

      if (hiddenView) {
        await hiddenView.webContents.executeJavaScript(code, true);
      } else {
        await this.tabViewManager.executeJavaScript(tabId, code);
      }
    },
  };

  // =========================================================================
  // chrome.cookies
  // =========================================================================

  cookies = {
    get: async(details: CookieGetDetails): Promise<ChromeCookie | null> => {
      const sess = session.fromPartition(SESSION_PARTITION);
      const cookies = await sess.cookies.get({ url: details.url, name: details.name });

      return cookies.length > 0 ? this.toChromeCookie(cookies[0]) : null;
    },

    getAll: async(details: CookieGetAllDetails): Promise<ChromeCookie[]> => {
      const sess = session.fromPartition(SESSION_PARTITION);
      const filter: Electron.CookiesGetFilter = {};

      if (details.url) filter.url = details.url;
      if (details.name) filter.name = details.name;
      if (details.domain) filter.domain = details.domain;
      if (details.path) filter.path = details.path;
      if (details.secure !== undefined) filter.secure = details.secure;

      const cookies = await sess.cookies.get(filter);

      return cookies.map((c) => this.toChromeCookie(c));
    },

    set: async(details: CookieSetDetails): Promise<ChromeCookie> => {
      const sess = session.fromPartition(SESSION_PARTITION);

      await sess.cookies.set({
        url:            details.url,
        name:           details.name,
        value:          details.value,
        domain:         details.domain,
        path:           details.path || '/',
        secure:         details.secure,
        httpOnly:       details.httpOnly,
        sameSite:       details.sameSite as any,
        expirationDate: details.expirationDate,
      });

      return {
        name:           details.name,
        value:          details.value,
        domain:         details.domain || new URL(details.url).hostname,
        path:           details.path || '/',
        secure:         !!details.secure,
        httpOnly:       !!details.httpOnly,
        sameSite:       details.sameSite || 'lax',
        expirationDate: details.expirationDate,
        url:            details.url,
      };
    },

    remove: async(details: CookieRemoveDetails): Promise<void> => {
      const sess = session.fromPartition(SESSION_PARTITION);

      await sess.cookies.remove(details.url, details.name);
    },
  };

  // =========================================================================
  // chrome.storage
  // =========================================================================

  storage = {
    local: this.localStorage,
  };

  // =========================================================================
  // chrome.windows
  // =========================================================================

  windows = {
    create: async(props: WindowCreateProperties): Promise<ChromeWindow> => {
      const windowId = `chrome-win-${ ++this.windowCounter }-${ Date.now() }`;
      const isHidden = props.state === 'hidden';

      const tab = await this.tabs.create({
        url:    props.url,
        hidden: isHidden,
        active: !isHidden,
      });

      this.windowRegistry.set(windowId, { state: isHidden ? 'hidden' : 'normal', tabId: tab.id });

      return {
        id:    windowId,
        state: isHidden ? 'hidden' : 'normal',
        tabs:  [tab],
      };
    },

    remove: async(windowId: string): Promise<void> => {
      const win = this.windowRegistry.get(windowId);

      if (!win) return;

      await this.tabs.remove(win.tabId);
      this.windowRegistry.delete(windowId);
    },

    get: async(windowId: string): Promise<ChromeWindow | null> => {
      const win = this.windowRegistry.get(windowId);

      if (!win) return null;

      const tab = await this.tabs.get(win.tabId);

      return {
        id:    windowId,
        state: win.state,
        tabs:  tab ? [tab] : [],
      };
    },
  };

  // =========================================================================
  // chrome.alarms
  // =========================================================================

  alarms = {
    create: async(name: string, alarmInfo: AlarmCreateInfo): Promise<void> => {
      // Clear any existing alarm with this name
      await this.alarms.clear(name);

      const now = Date.now();
      let scheduledTime: number;

      if (alarmInfo.when) {
        scheduledTime = alarmInfo.when;
      } else if (alarmInfo.delayInMinutes) {
        scheduledTime = now + alarmInfo.delayInMinutes * 60_000;
      } else if (alarmInfo.periodInMinutes) {
        scheduledTime = now + alarmInfo.periodInMinutes * 60_000;
      } else {
        throw new Error('[ChromeApi] alarms.create requires when, delayInMinutes, or periodInMinutes');
      }

      const alarm: ChromeAlarm = {
        name,
        scheduledTime,
        periodInMinutes: alarmInfo.periodInMinutes,
      };

      const delay = Math.max(0, scheduledTime - now);

      const fireAlarm = () => {
        this.alarmEvent.emit(alarm);

        if (alarmInfo.periodInMinutes) {
          // Set up repeating interval after initial fire
          alarm.scheduledTime = Date.now() + alarmInfo.periodInMinutes * 60_000;
          const interval = setInterval(() => {
            alarm.scheduledTime = Date.now() + alarmInfo.periodInMinutes! * 60_000;
            this.alarmEvent.emit(alarm);
          }, alarmInfo.periodInMinutes * 60_000);

          this.alarmTimers.set(name, { timer: interval, alarm });
        } else {
          this.alarmTimers.delete(name);
        }
      };

      const timer = setTimeout(fireAlarm, delay);

      this.alarmTimers.set(name, { timer, alarm });
      console.log(`[ChromeApi] Alarm created: ${ name } (fires in ${ Math.round(delay / 1000) }s)`);
    },

    get: async(name: string): Promise<ChromeAlarm | null> => {
      const entry = this.alarmTimers.get(name);

      return entry?.alarm ?? null;
    },

    getAll: async(): Promise<ChromeAlarm[]> => {
      return [...this.alarmTimers.values()].map((e) => e.alarm);
    },

    clear: async(name: string): Promise<boolean> => {
      const entry = this.alarmTimers.get(name);

      if (!entry) return false;

      clearTimeout(entry.timer as any);
      clearInterval(entry.timer as any);
      this.alarmTimers.delete(name);

      return true;
    },

    clearAll: async(): Promise<boolean> => {
      for (const [name] of this.alarmTimers) {
        await this.alarms.clear(name);
      }

      return true;
    },

    onAlarm: this.alarmEvent as ChromeEvent<[ChromeAlarm]>,
  };

  // =========================================================================
  // chrome.webRequest
  // =========================================================================

  webRequest = {
    onBeforeRequest:      this.webReqBeforeRequest     as ChromeEvent<[WebRequestDetails]>,
    onBeforeSendHeaders:  this.webReqBeforeSendHeaders  as ChromeEvent<[WebRequestHeadersDetails]>,
    onHeadersReceived:    this.webReqHeadersReceived    as ChromeEvent<[WebRequestResponseDetails]>,
    onCompleted:          this.webReqCompleted           as ChromeEvent<[WebRequestResponseDetails]>,
    onErrorOccurred:      this.webReqErrorOccurred       as ChromeEvent<[WebRequestDetails & { error: string }]>,
  };

  /**
   * Attach webRequest listeners to the shared browser session.
   * Called once during initialization to bridge Electron's session.webRequest
   * events into the chrome.webRequest event system.
   */
  initWebRequestBridge(): void {
    const sess = session.fromPartition(SESSION_PARTITION);

    sess.webRequest.onBeforeRequest((details) => {
      if (this.webReqBeforeRequest.hasListeners()) {
        this.webReqBeforeRequest.emit({
          requestId: String(details.id),
          url:       details.url,
          method:    details.method,
          type:      details.resourceType,
          tabId:     undefined,
          timeStamp: Date.now(),
        });
      }
    });

    sess.webRequest.onBeforeSendHeaders((details, callback) => {
      if (this.webReqBeforeSendHeaders.hasListeners()) {
        const headers = Object.entries(details.requestHeaders || {}).map(
          ([name, value]) => ({ name, value: String(value) }),
        );

        this.webReqBeforeSendHeaders.emit({
          requestId:      String(details.id),
          url:            details.url,
          method:         details.method,
          type:           details.resourceType,
          timeStamp:      Date.now(),
          requestHeaders: headers,
        });
      }
      callback({ cancel: false });
    });

    sess.webRequest.onHeadersReceived((details, callback) => {
      if (this.webReqHeadersReceived.hasListeners()) {
        const headers = Object.entries(details.responseHeaders || {}).map(
          ([name, value]) => ({ name, value: Array.isArray(value) ? value.join(', ') : String(value) }),
        );

        this.webReqHeadersReceived.emit({
          requestId:       String(details.id),
          url:             details.url,
          method:          details.method,
          statusCode:      details.statusCode,
          type:            details.resourceType,
          timeStamp:       Date.now(),
          responseHeaders: headers,
        });
      }
      callback({ cancel: false });
    });

    sess.webRequest.onCompleted((details) => {
      if (this.webReqCompleted.hasListeners()) {
        this.webReqCompleted.emit({
          requestId:  String(details.id),
          url:        details.url,
          method:     details.method,
          statusCode: details.statusCode,
          type:       details.resourceType,
          timeStamp:  Date.now(),
        });
      }
    });

    sess.webRequest.onErrorOccurred((details) => {
      if (this.webReqErrorOccurred.hasListeners()) {
        this.webReqErrorOccurred.emit({
          requestId: String(details.id),
          url:       details.url,
          method:    details.method,
          type:      details.resourceType,
          timeStamp: Date.now(),
          error:     details.error,
        });
      }
    });

    console.log('[ChromeApi] webRequest bridge attached');
  }

  // =========================================================================
  // chrome.contextMenus
  // =========================================================================

  contextMenus = {
    create: (props: ContextMenuCreateProperties): string => {
      const id = props.id || `ctx-${ ++this.contextMenuCounter }`;

      this.contextMenuItems.set(id, { ...props, id });

      return id;
    },

    update: async(id: string, props: ContextMenuUpdateProperties): Promise<void> => {
      const item = this.contextMenuItems.get(id);

      if (item) {
        Object.assign(item, props);
      }
    },

    remove: async(id: string): Promise<void> => {
      this.contextMenuItems.delete(id);
    },

    removeAll: async(): Promise<void> => {
      this.contextMenuItems.clear();
    },

    onClicked: this.contextMenuClickedEvent as ChromeEvent<[ContextMenuClickInfo, ChromeTab | null]>,
  };

  /**
   * Called from context menu action handlers to dispatch click events
   * for registered chrome.contextMenus items.
   */
  emitContextMenuClick(info: ContextMenuClickInfo, tab: ChromeTab | null): void {
    this.contextMenuClickedEvent.emit(info, tab);
  }

  /** Get all registered context menu items (for rendering in the context menu UI). */
  getContextMenuItems(): ContextMenuCreateProperties[] {
    return [...this.contextMenuItems.values()];
  }

  // =========================================================================
  // chrome.notifications
  // =========================================================================

  notifications = {
    create: async(notificationId: string, options: NotificationOptions): Promise<string> => {
      const notification = new Electron.Notification({
        title: options.title,
        body:  options.message,
        icon:  options.iconUrl || undefined,
        silent: options.silent,
      });

      notification.on('click', () => {
        this.notificationClickedEvent.emit(notificationId);
      });

      notification.on('close', () => {
        this.activeNotifications.delete(notificationId);
        this.notificationClosedEvent.emit(notificationId, false);
      });

      this.activeNotifications.set(notificationId, notification);
      notification.show();

      return notificationId;
    },

    clear: async(notificationId: string): Promise<boolean> => {
      const notification = this.activeNotifications.get(notificationId);

      if (!notification) return false;

      notification.close();
      this.activeNotifications.delete(notificationId);

      return true;
    },

    onClicked: this.notificationClickedEvent as ChromeEvent<[string]>,
    onClosed:  this.notificationClosedEvent  as ChromeEvent<[string, boolean]>,
  };

  // =========================================================================
  // chrome.webNavigation
  // =========================================================================

  webNavigation = {
    onBeforeNavigate: this.webNavBeforeNavigate as ChromeEvent<[WebNavigationDetails]>,
    onCommitted:      this.webNavCommitted      as ChromeEvent<[WebNavigationDetails]>,
    onCompleted:      this.webNavCompleted       as ChromeEvent<[WebNavigationDetails]>,
    onErrorOccurred:  this.webNavErrorOccurred   as ChromeEvent<[WebNavigationErrorDetails]>,
  };

  /**
   * Attach webNavigation listeners to a tab's webContents.
   * Called when a tab is created to bridge Electron navigation events
   * into the chrome.webNavigation event system.
   */
  attachWebNavigationListeners(tabId: string, wc: Electron.WebContents): void {
    wc.on('will-navigate', (_event, url) => {
      this.webNavBeforeNavigate.emit({ tabId, url, timeStamp: Date.now() });
    });

    wc.on('did-navigate', (_event, url) => {
      this.webNavCommitted.emit({ tabId, url, timeStamp: Date.now() });
    });

    wc.on('did-finish-load', () => {
      this.webNavCompleted.emit({ tabId, url: wc.getURL(), timeStamp: Date.now() });

      // Also record in history
      this.recordHistoryVisit(wc.getURL(), wc.getTitle());
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;

      this.webNavErrorOccurred.emit({
        tabId,
        url:       validatedURL,
        timeStamp: Date.now(),
        error:     `${ errorDescription } (${ errorCode })`,
      });
    });
  }

  // =========================================================================
  // chrome.commands
  // =========================================================================

  commands = {
    getAll: async(): Promise<ChromeCommand[]> => {
      return [...this.registeredCommands.values()];
    },

    onCommand: this.commandEvent as ChromeEvent<[string]>,
  };

  /**
   * Register a keyboard command. Wraps Electron's before-input-event pattern.
   */
  registerCommand(command: ChromeCommand, window: Electron.BrowserWindow): void {
    this.registeredCommands.set(command.name, command);

    // Parse shortcut string (e.g., "Ctrl+Shift+Y") into key components
    const parts = command.shortcut.toLowerCase().split('+');
    const key = parts.pop() || '';
    const modifiers = {
      ctrl:  parts.includes('ctrl') || parts.includes('control'),
      shift: parts.includes('shift'),
      alt:   parts.includes('alt'),
      meta:  parts.includes('meta') || parts.includes('command') || parts.includes('cmd'),
    };

    window.webContents.on('before-input-event', (_event, input) => {
      if (
        input.type === 'keyDown' &&
        input.key.toLowerCase() === key &&
        !!input.control === modifiers.ctrl &&
        !!input.shift === modifiers.shift &&
        !!input.alt === modifiers.alt &&
        !!input.meta === modifiers.meta
      ) {
        this.commandEvent.emit(command.name);
      }
    });
  }

  // =========================================================================
  // chrome.tts
  // =========================================================================

  tts = {
    speak: async(utterance: string, _options?: TtsOptions): Promise<void> => {
      this.ttsEvent.emit({ type: 'start' });

      try {
        // Use the IPC channel that TTSPlayerService listens on
        const { ipcMain } = Electron;
        // Invoke the audio-speak handler directly
        const result = await new Promise<void>((resolve, reject) => {
          // Send through the renderer's TTS pipeline via IPC
          const mainWindow = require('@pkg/window').getWindow('main-agent');

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('chrome-api:tts:speak', utterance);
            resolve();
          } else {
            reject(new Error('No main window available for TTS'));
          }
        });

        this.ttsEvent.emit({ type: 'end' });
      } catch (err) {
        this.ttsEvent.emit({ type: 'error' });
        console.error('[ChromeApi] TTS speak failed:', err);
      }
    },

    stop: (): void => {
      const mainWindow = require('@pkg/window').getWindow('main-agent');

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome-api:tts:stop');
      }
    },

    getVoices: async(): Promise<TtsVoice[]> => {
      // Return the system default — actual voice enumeration happens renderer-side
      return [{ voiceName: 'System Default', lang: 'en-US' }];
    },

    onEvent: this.ttsEvent as ChromeEvent<[{ type: 'start' | 'end' | 'error'; charIndex?: number }]>,
  };

  // =========================================================================
  // chrome.action (Tier 2)
  // =========================================================================

  action = {
    setIcon: async(details: ActionSetIconDetails): Promise<void> => {
      this.actionState.icon = details.path || '';
    },

    setBadgeText: async(details: ActionSetBadgeDetails): Promise<void> => {
      this.actionState.badgeText = details.text;
    },

    setBadgeBackgroundColor: async(details: { color: string; tabId?: string }): Promise<void> => {
      this.actionState.badgeColor = details.color;
    },

    setTitle: async(details: ActionSetTitleDetails): Promise<void> => {
      this.actionState.title = details.title;
    },

    onClicked: this.actionClickedEvent as ChromeEvent<[ChromeTab]>,
  };

  /** Get current action state (for rendering the toolbar button). */
  getActionState(): { icon: string; badgeText: string; badgeColor: string; title: string } {
    return { ...this.actionState };
  }

  // =========================================================================
  // chrome.downloads (Tier 2)
  // =========================================================================

  downloads = {
    download: async(options: DownloadOptions): Promise<string> => {
      const downloadId = `dl-${ ++this.downloadCounter }-${ Date.now() }`;
      const item: DownloadItem = {
        id:            downloadId,
        url:           options.url,
        filename:      options.filename || '',
        state:         'in_progress',
        bytesReceived: 0,
        totalBytes:    -1,
        startTime:     Date.now(),
      };

      this.activeDownloads.set(downloadId, item);
      this.downloadCreatedEvent.emit(item);

      // Trigger the actual download via the browser session
      const sess = session.fromPartition(SESSION_PARTITION);

      sess.once('will-download', (_event, electronItem) => {
        if (options.filename) {
          electronItem.setSavePath(options.filename);
        }

        item.totalBytes = electronItem.getTotalBytes();
        item.filename = electronItem.getFilename();

        electronItem.on('updated', (_event, state) => {
          item.bytesReceived = electronItem.getReceivedBytes();
          item.state = state === 'progressing' ? 'in_progress' : 'interrupted';
          this.downloadChangedEvent.emit({ id: downloadId, state: { current: item.state } });
        });

        electronItem.once('done', (_event, state) => {
          item.state = state === 'completed' ? 'complete' : 'interrupted';
          item.bytesReceived = electronItem.getReceivedBytes();
          this.downloadChangedEvent.emit({ id: downloadId, state: { current: item.state } });
        });
      });

      // Initiate the download from main process
      const mainWindow = require('@pkg/window').getWindow('main-agent');

      if (mainWindow) {
        mainWindow.webContents.downloadURL(options.url);
      }

      return downloadId;
    },

    search: async(query: DownloadQuery): Promise<DownloadItem[]> => {
      let results = [...this.activeDownloads.values()];

      if (query.state) results = results.filter((d) => d.state === query.state);
      if (query.filename) results = results.filter((d) => d.filename.includes(query.filename!));
      if (query.url) results = results.filter((d) => d.url.includes(query.url!));

      return results;
    },

    cancel: async(downloadId: string): Promise<void> => {
      const item = this.activeDownloads.get(downloadId);

      if (item) {
        item.state = 'interrupted';
        this.downloadChangedEvent.emit({ id: downloadId, state: { current: 'interrupted' } });
      }
    },

    pause: async(downloadId: string): Promise<void> => {
      // Electron doesn't expose pause on DownloadItem from main process
      console.log(`[ChromeApi] downloads.pause(${ downloadId }) — not supported`);
    },

    resume: async(downloadId: string): Promise<void> => {
      console.log(`[ChromeApi] downloads.resume(${ downloadId }) — not supported`);
    },

    onCreated: this.downloadCreatedEvent as ChromeEvent<[DownloadItem]>,
    onChanged: this.downloadChangedEvent as ChromeEvent<[{ id: string; state?: { current: string } }]>,
  };

  // =========================================================================
  // chrome.history (Tier 2)
  // =========================================================================

  history = {
    search: async(query: HistoryQuery): Promise<HistoryItem[]> => {
      await this.ensureHistoryLoaded();

      let results = this.historyItems;

      if (query.text) {
        const text = query.text.toLowerCase();

        results = results.filter((h) =>
          h.url.toLowerCase().includes(text) || h.title.toLowerCase().includes(text),
        );
      }
      if (query.startTime) results = results.filter((h) => h.lastVisitTime >= query.startTime!);
      if (query.endTime) results = results.filter((h) => h.lastVisitTime <= query.endTime!);

      results.sort((a, b) => b.lastVisitTime - a.lastVisitTime);

      if (query.maxResults) results = results.slice(0, query.maxResults);

      return results;
    },

    addUrl: async(details: { url: string; title?: string }): Promise<void> => {
      await this.recordHistoryVisit(details.url, details.title || '');
    },

    deleteUrl: async(details: { url: string }): Promise<void> => {
      await this.ensureHistoryLoaded();
      this.historyItems = this.historyItems.filter((h) => h.url !== details.url);
      await this.persistHistory();
    },

    deleteAll: async(): Promise<void> => {
      this.historyItems = [];
      await this.persistHistory();
    },

    onVisited: this.historyVisitedEvent as ChromeEvent<[HistoryItem]>,
  };

  /** Record a URL visit (called from webNavigation.onCompleted and history.addUrl). */
  private async recordHistoryVisit(url: string, title: string): Promise<void> {
    if (!url || url.startsWith('data:') || url.startsWith('about:')) return;

    await this.ensureHistoryLoaded();

    const existing = this.historyItems.find((h) => h.url === url);

    if (existing) {
      existing.lastVisitTime = Date.now();
      existing.visitCount++;
      if (title) existing.title = title;
      this.historyVisitedEvent.emit(existing);
    } else {
      const item: HistoryItem = {
        id:            `hist-${ ++this.historyCounter }`,
        url,
        title:         title || url,
        lastVisitTime: Date.now(),
        visitCount:    1,
      };

      this.historyItems.push(item);
      this.historyVisitedEvent.emit(item);
    }

    await this.persistHistory();
  }

  private async ensureHistoryLoaded(): Promise<void> {
    if (this.historyLoaded) return;
    this.historyLoaded = true;

    try {
      const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
      const data = await SullaSettingsModel.get('chrome.history.items');

      if (Array.isArray(data)) {
        this.historyItems = data;
        this.historyCounter = data.length;
      }
    } catch {
      // First run or DB not ready — start empty
    }
  }

  private async persistHistory(): Promise<void> {
    try {
      const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');

      // Keep last 1000 entries
      if (this.historyItems.length > 1000) {
        this.historyItems.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
        this.historyItems = this.historyItems.slice(0, 1000);
      }

      await SullaSettingsModel.set('chrome.history.items', this.historyItems, 'json');
    } catch (err) {
      console.error('[ChromeApi] Failed to persist history:', err);
    }
  }

  // =========================================================================
  // chrome.sidePanel (Tier 2)
  // =========================================================================

  sidePanel = {
    open: async(_options: { tabId?: string }): Promise<void> => {
      if (!this.sidePanelOptions.path) {
        console.warn('[ChromeApi] sidePanel.open: no path set');

        return;
      }

      if (this.sidePanelView) return; // already open

      const mainWindow = require('@pkg/window').getWindow('main-agent');

      if (!mainWindow) return;

      const sess = session.fromPartition(SESSION_PARTITION);
      const view = new WebContentsView({
        webPreferences: {
          webSecurity:      false,
          contextIsolation: false,
          nodeIntegration:  false,
          partition:        SESSION_PARTITION,
        },
      });

      const bounds = mainWindow.getBounds();

      view.setBounds({
        x:      Math.floor(bounds.width * 0.7),
        y:      0,
        width:  Math.floor(bounds.width * 0.3),
        height: bounds.height,
      });

      mainWindow.contentView.addChildView(view);
      view.webContents.loadURL(this.sidePanelOptions.path).catch((err: Error) => {
        console.error('[ChromeApi] sidePanel load failed:', err);
      });

      this.sidePanelView = view;
    },

    close: async(_options: { tabId?: string }): Promise<void> => {
      if (!this.sidePanelView) return;

      const mainWindow = require('@pkg/window').getWindow('main-agent');

      if (mainWindow) {
        try {
          mainWindow.contentView.removeChildView(this.sidePanelView);
        } catch { /* may already be detached */ }
      }

      (this.sidePanelView.webContents as any).close?.();
      this.sidePanelView = null;
    },

    setOptions: async(options: SidePanelOptions): Promise<void> => {
      this.sidePanelOptions = { ...this.sidePanelOptions, ...options };
    },

    getOptions: async(): Promise<SidePanelOptions> => {
      return { ...this.sidePanelOptions };
    },
  };

  // =========================================================================
  // chrome.runtime
  // =========================================================================

  runtime = {
    sendMessage: async(message: RuntimeMessage): Promise<unknown> => {
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (response: unknown) => {
          if (!responded) {
            responded = true;
            resolve(response);
          }
        };

        this.runtimeMessageEvent.emit(message, { id: 'sulla-main' }, sendResponse);

        // If no listener called sendResponse synchronously, resolve with undefined
        setTimeout(() => {
          if (!responded) {
            resolve(undefined);
          }
        }, 0);
      });
    },

    onMessage: this.runtimeMessageEvent as ChromeEvent<[RuntimeMessage, { id: string }, (response: unknown) => void]>,
  };

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * Build a ChromeTab object from a tabId by checking both visible and hidden views.
   */
  private async buildTabInfo(tabId: string): Promise<ChromeTab | null> {
    const hiddenView = this.hiddenViews.get(tabId);

    if (hiddenView) {
      const wc = hiddenView.webContents;

      return {
        id:     tabId,
        url:    wc.getURL(),
        title:  wc.getTitle(),
        active: false,
        status: wc.isLoading() ? 'loading' : 'complete',
        hidden: true,
      };
    }

    // Check the managed tab views
    const wc = this.tabViewManager.getWebContents(tabId);

    if (wc) {
      const activeAssetId = await hostBridgeProxy.getActiveAssetId();

      return {
        id:     tabId,
        url:    wc.getURL(),
        title:  wc.getTitle(),
        active: tabId === activeAssetId,
        status: wc.isLoading() ? 'loading' : 'complete',
        hidden: false,
      };
    }

    // Try to get info from the bridge registry (for non-WebContentsView tabs)
    const assets = await hostBridgeProxy.getAllAssetInfo();
    const asset = assets.find((a) => a.assetId === tabId);

    if (asset) {
      const activeAssetId = await hostBridgeProxy.getActiveAssetId();

      return {
        id:     tabId,
        url:    asset.url,
        title:  asset.title,
        active: tabId === activeAssetId,
        status: 'complete',
        hidden: false,
      };
    }

    return null;
  }

  private toChromeCookie(cookie: Electron.Cookie): ChromeCookie {
    return {
      name:           cookie.name,
      value:          cookie.value,
      domain:         cookie.domain || '',
      path:           cookie.path || '/',
      secure:         cookie.secure || false,
      httpOnly:       cookie.httpOnly || false,
      sameSite:       cookie.sameSite || 'unspecified',
      expirationDate: cookie.expirationDate,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton accessor
// ---------------------------------------------------------------------------

let _chromeApi: ChromeApiService | undefined;

export function getChromeApi(): ChromeApiService {
  if (!_chromeApi) {
    const { BrowserTabViewManager } = require('@pkg/window/browserTabViewManager');

    _chromeApi = ChromeApiService.getInstance(BrowserTabViewManager.getInstance());
  }

  return _chromeApi;
}
