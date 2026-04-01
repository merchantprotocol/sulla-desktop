/**
 * TypeScript interfaces for the chrome.* API layer.
 *
 * These types mirror a subset of the Chrome Extensions API surface,
 * adapted for the Sulla Desktop main-process context.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventListener<T extends unknown[]> = (...args: T) => void;

export interface ChromeEvent<T extends unknown[]> {
  addListener(callback: EventListener<T>): void;
  removeListener(callback: EventListener<T>): void;
  hasListeners(): boolean;
}

// ---------------------------------------------------------------------------
// chrome.tabs
// ---------------------------------------------------------------------------

export interface ChromeTab {
  id:     string;
  url:    string;
  title:  string;
  active: boolean;
  status: 'loading' | 'complete';
  /** Whether the tab's WebContentsView is attached to a visible window. */
  hidden: boolean;
}

export interface TabQueryInfo {
  active?: boolean;
  url?:    string;
  title?:  string;
  hidden?: boolean;
}

export interface TabCreateProperties {
  url:     string;
  active?: boolean;
  /** Create the WebContentsView without attaching it to any parent window. */
  hidden?: boolean;
}

export interface TabUpdateProperties {
  url?:    string;
  active?: boolean;
}

export interface TabChangeInfo {
  status?: 'loading' | 'complete';
  url?:    string;
  title?:  string;
}

// ---------------------------------------------------------------------------
// chrome.scripting
// ---------------------------------------------------------------------------

export interface ScriptInjectionTarget {
  tabId: string;
}

export interface ScriptInjection {
  target: ScriptInjectionTarget;
  /** A function to serialize and execute in the tab context. */
  func?:  (...args: unknown[]) => unknown;
  /** Raw JavaScript code string. */
  code?:  string;
  /** Arguments to pass to func (serialized via JSON). */
  args?:  unknown[];
}

export interface CSSInjection {
  target: ScriptInjectionTarget;
  css:    string;
}

export interface InjectionResult {
  result: unknown;
}

// ---------------------------------------------------------------------------
// chrome.cookies
// ---------------------------------------------------------------------------

export interface ChromeCookie {
  name:            string;
  value:           string;
  domain:          string;
  path:            string;
  secure:          boolean;
  httpOnly:        boolean;
  sameSite:        string;
  expirationDate?: number;
  url?:            string;
}

export interface CookieGetDetails {
  url:  string;
  name: string;
}

export interface CookieGetAllDetails {
  url?:    string;
  name?:   string;
  domain?: string;
  path?:   string;
  secure?: boolean;
}

export interface CookieSetDetails {
  url:             string;
  name:            string;
  value:           string;
  domain?:         string;
  path?:           string;
  secure?:         boolean;
  httpOnly?:       boolean;
  sameSite?:       'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

export interface CookieRemoveDetails {
  url:  string;
  name: string;
}

// ---------------------------------------------------------------------------
// chrome.storage
// ---------------------------------------------------------------------------

export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// chrome.windows
// ---------------------------------------------------------------------------

export interface ChromeWindow {
  id:     string;
  state:  'normal' | 'hidden';
  tabs:   ChromeTab[];
}

export interface WindowCreateProperties {
  url:    string;
  state?: 'normal' | 'hidden';
}

// ---------------------------------------------------------------------------
// chrome.alarms
// ---------------------------------------------------------------------------

export interface AlarmCreateInfo {
  /** Delay in minutes before the alarm fires. */
  delayInMinutes?:  number;
  /** Repeating period in minutes. */
  periodInMinutes?: number;
  /** Absolute time (ms since epoch) when the alarm should fire. */
  when?:            number;
}

export interface ChromeAlarm {
  name:            string;
  scheduledTime:   number;
  periodInMinutes?: number;
}

// ---------------------------------------------------------------------------
// chrome.webRequest
// ---------------------------------------------------------------------------

export interface WebRequestFilter {
  urls:  string[];
  types?: string[];
}

export interface WebRequestDetails {
  requestId:    string;
  url:          string;
  method:       string;
  frameId?:     number;
  tabId?:       string;
  type?:        string;
  timeStamp:    number;
}

export interface WebRequestHeadersDetails extends WebRequestDetails {
  requestHeaders?: Array<{ name: string; value: string }>;
}

export interface WebRequestResponseDetails extends WebRequestDetails {
  statusCode:       number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

// ---------------------------------------------------------------------------
// chrome.contextMenus
// ---------------------------------------------------------------------------

export interface ContextMenuCreateProperties {
  id?:       string;
  title:     string;
  contexts?: Array<'page' | 'selection' | 'link' | 'image' | 'editable' | 'all'>;
  parentId?: string;
  enabled?:  boolean;
}

export interface ContextMenuUpdateProperties {
  title?:   string;
  enabled?: boolean;
}

export interface ContextMenuClickInfo {
  menuItemId:    string;
  parentMenuId?: string;
  selectionText?: string;
  linkUrl?:       string;
  srcUrl?:        string;
  pageUrl:        string;
  editable:       boolean;
}

// ---------------------------------------------------------------------------
// chrome.notifications
// ---------------------------------------------------------------------------

export interface NotificationOptions {
  type?:     'basic' | 'image' | 'list' | 'progress';
  title:     string;
  message:   string;
  iconUrl?:  string;
  priority?: -2 | -1 | 0 | 1 | 2;
  silent?:   boolean;
}

// ---------------------------------------------------------------------------
// chrome.webNavigation
// ---------------------------------------------------------------------------

export interface WebNavigationDetails {
  tabId:     string;
  url:       string;
  frameId?:  number;
  timeStamp: number;
}

export interface WebNavigationErrorDetails extends WebNavigationDetails {
  error: string;
}

// ---------------------------------------------------------------------------
// chrome.commands
// ---------------------------------------------------------------------------

export interface ChromeCommand {
  name:         string;
  shortcut:     string;
  description?: string;
}

// ---------------------------------------------------------------------------
// chrome.tts
// ---------------------------------------------------------------------------

export interface TtsOptions {
  rate?:   number;
  pitch?:  number;
  volume?: number;
  lang?:   string;
}

export interface TtsVoice {
  voiceName: string;
  lang?:     string;
  remote?:   boolean;
}

// ---------------------------------------------------------------------------
// chrome.action (Tier 2)
// ---------------------------------------------------------------------------

export interface ActionSetIconDetails {
  tabId?: string;
  path?:  string;
}

export interface ActionSetBadgeDetails {
  text:   string;
  tabId?: string;
}

export interface ActionSetTitleDetails {
  title:  string;
  tabId?: string;
}

// ---------------------------------------------------------------------------
// chrome.downloads (Tier 2)
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  url:             string;
  filename?:       string;
  saveAs?:         boolean;
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
}

export interface DownloadItem {
  id:          string;
  url:         string;
  filename:    string;
  state:       'in_progress' | 'complete' | 'interrupted';
  bytesReceived: number;
  totalBytes:    number;
  startTime:     number;
}

export interface DownloadQuery {
  state?:    string;
  filename?: string;
  url?:      string;
}

// ---------------------------------------------------------------------------
// chrome.history (Tier 2)
// ---------------------------------------------------------------------------

export interface HistoryItem {
  id:          string;
  url:         string;
  title:       string;
  lastVisitTime: number;
  visitCount:    number;
}

export interface HistoryQuery {
  text:       string;
  startTime?: number;
  endTime?:   number;
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// chrome.sidePanel (Tier 2)
// ---------------------------------------------------------------------------

export interface SidePanelOptions {
  path:    string;
  enabled?: boolean;
}

/** Payload sent from the renderer to the side panel chat via sendPrompt(). */
export interface SidePanelPromptPayload {
  prompt:       string;
  /** Tab context — URL and title of the page the action was triggered from. */
  tab?: {
    url:   string;
    title: string;
  };
  /** Selected text from the page (for "Ask Sulla", "Summarize", etc.). */
  selectionText?: string;
  /** Image attachments (e.g. screenshots) as base64-encoded data. */
  attachments?: Array<{ mediaType: string; base64: string }>;
}

// ---------------------------------------------------------------------------
// chrome.runtime
// ---------------------------------------------------------------------------

export interface RuntimeMessage {
  type:    string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Full chrome.* namespace interface
// ---------------------------------------------------------------------------

export interface ChromeApi {
  tabs: {
    get(tabId: string): Promise<ChromeTab | null>;
    query(queryInfo: TabQueryInfo): Promise<ChromeTab[]>;
    create(props: TabCreateProperties): Promise<ChromeTab>;
    remove(tabId: string): Promise<void>;
    update(tabId: string, props: TabUpdateProperties): Promise<ChromeTab | null>;
    reload(tabId: string): Promise<void>;
    goBack(tabId: string): Promise<void>;
    goForward(tabId: string): Promise<void>;
    onCreated:  ChromeEvent<[ChromeTab]>;
    onRemoved:  ChromeEvent<[string]>;
    onUpdated:  ChromeEvent<[string, TabChangeInfo, ChromeTab]>;
  };

  scripting: {
    executeScript(injection: ScriptInjection): Promise<InjectionResult[]>;
    insertCSS(injection: CSSInjection): Promise<void>;
  };

  cookies: {
    get(details: CookieGetDetails): Promise<ChromeCookie | null>;
    getAll(details: CookieGetAllDetails): Promise<ChromeCookie[]>;
    set(details: CookieSetDetails): Promise<ChromeCookie>;
    remove(details: CookieRemoveDetails): Promise<void>;
  };

  storage: {
    local: StorageArea;
  };

  windows: {
    create(props: WindowCreateProperties): Promise<ChromeWindow>;
    remove(windowId: string): Promise<void>;
    get(windowId: string): Promise<ChromeWindow | null>;
  };

  alarms: {
    create(name: string, alarmInfo: AlarmCreateInfo): Promise<void>;
    get(name: string): Promise<ChromeAlarm | null>;
    getAll(): Promise<ChromeAlarm[]>;
    clear(name: string): Promise<boolean>;
    clearAll(): Promise<boolean>;
    onAlarm: ChromeEvent<[ChromeAlarm]>;
  };

  webRequest: {
    onBeforeRequest:      ChromeEvent<[WebRequestDetails]>;
    onBeforeSendHeaders:  ChromeEvent<[WebRequestHeadersDetails]>;
    onHeadersReceived:    ChromeEvent<[WebRequestResponseDetails]>;
    onCompleted:          ChromeEvent<[WebRequestResponseDetails]>;
    onErrorOccurred:      ChromeEvent<[WebRequestDetails & { error: string }]>;
  };

  contextMenus: {
    create(props: ContextMenuCreateProperties): string;
    update(id: string, props: ContextMenuUpdateProperties): Promise<void>;
    remove(id: string): Promise<void>;
    removeAll(): Promise<void>;
    onClicked: ChromeEvent<[ContextMenuClickInfo, ChromeTab | null]>;
  };

  notifications: {
    create(notificationId: string, options: NotificationOptions): Promise<string>;
    clear(notificationId: string): Promise<boolean>;
    onClicked: ChromeEvent<[string]>;
    onClosed:  ChromeEvent<[string, boolean]>;
  };

  webNavigation: {
    onBeforeNavigate: ChromeEvent<[WebNavigationDetails]>;
    onCommitted:      ChromeEvent<[WebNavigationDetails]>;
    onCompleted:      ChromeEvent<[WebNavigationDetails]>;
    onErrorOccurred:  ChromeEvent<[WebNavigationErrorDetails]>;
  };

  commands: {
    getAll(): Promise<ChromeCommand[]>;
    onCommand: ChromeEvent<[string]>;
  };

  tts: {
    speak(utterance: string, options?: TtsOptions): Promise<void>;
    stop(): void;
    getVoices(): Promise<TtsVoice[]>;
    onEvent: ChromeEvent<[{ type: 'start' | 'end' | 'error'; charIndex?: number }]>;
  };

  action: {
    setIcon(details: ActionSetIconDetails): Promise<void>;
    setBadgeText(details: ActionSetBadgeDetails): Promise<void>;
    setBadgeBackgroundColor(details: { color: string; tabId?: string }): Promise<void>;
    setTitle(details: ActionSetTitleDetails): Promise<void>;
    onClicked: ChromeEvent<[ChromeTab]>;
  };

  downloads: {
    download(options: DownloadOptions): Promise<string>;
    search(query: DownloadQuery): Promise<DownloadItem[]>;
    cancel(downloadId: string): Promise<void>;
    pause(downloadId: string): Promise<void>;
    resume(downloadId: string): Promise<void>;
    onCreated:  ChromeEvent<[DownloadItem]>;
    onChanged:  ChromeEvent<[{ id: string; state?: { current: string } }]>;
  };

  history: {
    search(query: HistoryQuery): Promise<HistoryItem[]>;
    addUrl(details: { url: string; title?: string }): Promise<void>;
    deleteUrl(details: { url: string }): Promise<void>;
    deleteAll(): Promise<void>;
    onVisited: ChromeEvent<[HistoryItem]>;
  };

  sidePanel: {
    open(options: { tabId?: string }): Promise<void>;
    close(options: { tabId?: string; all?: boolean }): Promise<void>;
    switchTab(tabId: string): Promise<void>;
    setOptions(options: SidePanelOptions): Promise<void>;
    getOptions(): Promise<SidePanelOptions>;
    sendPrompt(payload: string | SidePanelPromptPayload): Promise<void>;
    setBounds(bounds: Electron.Rectangle): Promise<void>;
  };

  runtime: {
    sendMessage(message: RuntimeMessage): Promise<unknown>;
    onMessage: ChromeEvent<[RuntimeMessage, { id: string }, (response: unknown) => void]>;
  };
}
