/**
 * Chrome API preload script.
 *
 * Exposes chrome.* APIs to content script contexts via Electron's contextBridge.
 * This runs in the preload (isolated world) and forwards calls to the main
 * process via IPC.
 *
 * Note: This is NOT injected into page context (window.__sulla lives there).
 * This runs in the same isolation layer as Electron's content scripts.
 */

import { contextBridge, ipcRenderer } from 'electron';

/** Helper to create an event listener bridge from IPC channel. */
function makeEventBridge(channel: string) {
  return {
    addListener: (callback: (...args: any[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    },
    removeListener: (_callback: (...args: any[]) => void) => {
      ipcRenderer.removeAllListeners(channel);
    },
    hasListeners: () => ipcRenderer.listenerCount(channel) > 0,
  };
}

const chromeApi = {
  tabs: {
    get:       (tabId: string) => ipcRenderer.invoke('chrome-api:tabs:get', tabId),
    query:     (queryInfo: any) => ipcRenderer.invoke('chrome-api:tabs:query', queryInfo),
    create:    (props: any) => ipcRenderer.invoke('chrome-api:tabs:create', props),
    remove:    (tabId: string) => ipcRenderer.invoke('chrome-api:tabs:remove', tabId),
    update:    (tabId: string, props: any) => ipcRenderer.invoke('chrome-api:tabs:update', tabId, props),
    reload:    (tabId: string) => ipcRenderer.invoke('chrome-api:tabs:reload', tabId),
    goBack:    (tabId: string) => ipcRenderer.invoke('chrome-api:tabs:goBack', tabId),
    goForward: (tabId: string) => ipcRenderer.invoke('chrome-api:tabs:goForward', tabId),
    onCreated:  makeEventBridge('chrome-api:tabs:onCreated'),
    onRemoved:  makeEventBridge('chrome-api:tabs:onRemoved'),
    onUpdated:  makeEventBridge('chrome-api:tabs:onUpdated'),
  },

  scripting: {
    executeScript: (injection: any) => ipcRenderer.invoke('chrome-api:scripting:executeScript', injection),
    insertCSS:     (injection: any) => ipcRenderer.invoke('chrome-api:scripting:insertCSS', injection),
  },

  cookies: {
    get:    (details: any) => ipcRenderer.invoke('chrome-api:cookies:get', details),
    getAll: (details: any) => ipcRenderer.invoke('chrome-api:cookies:getAll', details),
    set:    (details: any) => ipcRenderer.invoke('chrome-api:cookies:set', details),
    remove: (details: any) => ipcRenderer.invoke('chrome-api:cookies:remove', details),
  },

  storage: {
    local: {
      get:    (keys: any) => ipcRenderer.invoke('chrome-api:storage:local:get', keys),
      set:    (items: any) => ipcRenderer.invoke('chrome-api:storage:local:set', items),
      remove: (keys: any) => ipcRenderer.invoke('chrome-api:storage:local:remove', keys),
    },
  },

  windows: {
    create: (props: any) => ipcRenderer.invoke('chrome-api:windows:create', props),
    remove: (windowId: string) => ipcRenderer.invoke('chrome-api:windows:remove', windowId),
    get:    (windowId: string) => ipcRenderer.invoke('chrome-api:windows:get', windowId),
  },

  alarms: {
    create:   (name: string, alarmInfo: any) => ipcRenderer.invoke('chrome-api:alarms:create', name, alarmInfo),
    get:      (name: string) => ipcRenderer.invoke('chrome-api:alarms:get', name),
    getAll:   () => ipcRenderer.invoke('chrome-api:alarms:getAll'),
    clear:    (name: string) => ipcRenderer.invoke('chrome-api:alarms:clear', name),
    clearAll: () => ipcRenderer.invoke('chrome-api:alarms:clearAll'),
    onAlarm:  makeEventBridge('chrome-api:alarms:onAlarm'),
  },

  webRequest: {
    onBeforeRequest:     makeEventBridge('chrome-api:webRequest:onBeforeRequest'),
    onBeforeSendHeaders: makeEventBridge('chrome-api:webRequest:onBeforeSendHeaders'),
    onHeadersReceived:   makeEventBridge('chrome-api:webRequest:onHeadersReceived'),
    onCompleted:         makeEventBridge('chrome-api:webRequest:onCompleted'),
    onErrorOccurred:     makeEventBridge('chrome-api:webRequest:onErrorOccurred'),
  },

  contextMenus: {
    create:    (props: any) => ipcRenderer.invoke('chrome-api:contextMenus:create', props),
    update:    (id: string, props: any) => ipcRenderer.invoke('chrome-api:contextMenus:update', id, props),
    remove:    (id: string) => ipcRenderer.invoke('chrome-api:contextMenus:remove', id),
    removeAll: () => ipcRenderer.invoke('chrome-api:contextMenus:removeAll'),
    onClicked: makeEventBridge('chrome-api:contextMenus:onClicked'),
  },

  notifications: {
    create:    (id: string, options: any) => ipcRenderer.invoke('chrome-api:notifications:create', id, options),
    clear:     (id: string) => ipcRenderer.invoke('chrome-api:notifications:clear', id),
    onClicked: makeEventBridge('chrome-api:notifications:onClicked'),
    onClosed:  makeEventBridge('chrome-api:notifications:onClosed'),
  },

  webNavigation: {
    onBeforeNavigate: makeEventBridge('chrome-api:webNavigation:onBeforeNavigate'),
    onCommitted:      makeEventBridge('chrome-api:webNavigation:onCommitted'),
    onCompleted:      makeEventBridge('chrome-api:webNavigation:onCompleted'),
    onErrorOccurred:  makeEventBridge('chrome-api:webNavigation:onErrorOccurred'),
  },

  commands: {
    getAll:    () => ipcRenderer.invoke('chrome-api:commands:getAll'),
    onCommand: makeEventBridge('chrome-api:commands:onCommand'),
  },

  tts: {
    speak:     (utterance: string, options?: any) => ipcRenderer.invoke('chrome-api:tts:speak', utterance, options),
    stop:      () => ipcRenderer.invoke('chrome-api:tts:stop'),
    getVoices: () => ipcRenderer.invoke('chrome-api:tts:getVoices'),
    onEvent:   makeEventBridge('chrome-api:tts:onEvent'),
  },

  action: {
    setIcon:                 (details: any) => ipcRenderer.invoke('chrome-api:action:setIcon', details),
    setBadgeText:            (details: any) => ipcRenderer.invoke('chrome-api:action:setBadgeText', details),
    setBadgeBackgroundColor: (details: any) => ipcRenderer.invoke('chrome-api:action:setBadgeBackgroundColor', details),
    setTitle:                (details: any) => ipcRenderer.invoke('chrome-api:action:setTitle', details),
    onClicked:               makeEventBridge('chrome-api:action:onClicked'),
  },

  downloads: {
    download:  (options: any) => ipcRenderer.invoke('chrome-api:downloads:download', options),
    search:    (query: any) => ipcRenderer.invoke('chrome-api:downloads:search', query),
    cancel:    (id: string) => ipcRenderer.invoke('chrome-api:downloads:cancel', id),
    pause:     (id: string) => ipcRenderer.invoke('chrome-api:downloads:pause', id),
    resume:    (id: string) => ipcRenderer.invoke('chrome-api:downloads:resume', id),
    onCreated: makeEventBridge('chrome-api:downloads:onCreated'),
    onChanged: makeEventBridge('chrome-api:downloads:onChanged'),
  },

  history: {
    search:    (query: any) => ipcRenderer.invoke('chrome-api:history:search', query),
    addUrl:    (details: any) => ipcRenderer.invoke('chrome-api:history:addUrl', details),
    deleteUrl: (details: any) => ipcRenderer.invoke('chrome-api:history:deleteUrl', details),
    deleteAll: () => ipcRenderer.invoke('chrome-api:history:deleteAll'),
    onVisited: makeEventBridge('chrome-api:history:onVisited'),
  },

  sidePanel: {
    open:       (options?: any) => ipcRenderer.invoke('chrome-api:sidePanel:open', options || {}),
    close:      (options?: any) => ipcRenderer.invoke('chrome-api:sidePanel:close', options || {}),
    setOptions: (options: any) => ipcRenderer.invoke('chrome-api:sidePanel:setOptions', options),
    getOptions: () => ipcRenderer.invoke('chrome-api:sidePanel:getOptions'),
    sendPrompt: (prompt: string) => ipcRenderer.invoke('chrome-api:sidePanel:sendPrompt', prompt),
  },

  runtime: {
    sendMessage: (message: any) => ipcRenderer.invoke('chrome-api:runtime:sendMessage', message),
    onMessage:   makeEventBridge('chrome-api:runtime:onMessage'),
  },
};

// Expose as `chrome` in isolated contexts (content script equivalent).
// In page context, window.__sulla remains the API — this is the bridge layer.
try {
  contextBridge.exposeInMainWorld('chrome', chromeApi);
} catch {
  // contextBridge may fail if contextIsolation is disabled — fall back to
  // direct assignment so the API is still available.
  (globalThis as any).chrome = chromeApi;
}
