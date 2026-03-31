/**
 * IPC handler registration for the chrome.* API.
 *
 * Exposes chrome.tabs, chrome.scripting, chrome.cookies, chrome.storage,
 * chrome.windows, and chrome.runtime to renderer processes via IPC invoke.
 *
 * Channel naming convention: 'chrome-api:<namespace>:<method>'
 */

import Electron from 'electron';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { getChromeApi } from './ChromeApiService';

const console = Logging.sulla;

export function initChromeApiIpc(): void {
  const ipcMainProxy = getIpcMainProxy(console);
  const chrome = getChromeApi();

  // ── chrome.tabs ──────────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:tabs:get' as any, async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    return chrome.tabs.get(tabId);
  });

  ipcMainProxy.handle('chrome-api:tabs:query' as any, async(_event: Electron.IpcMainInvokeEvent, queryInfo: any) => {
    return chrome.tabs.query(queryInfo || {});
  });

  ipcMainProxy.handle('chrome-api:tabs:create' as any, async(_event: Electron.IpcMainInvokeEvent, props: any) => {
    return chrome.tabs.create(props);
  });

  ipcMainProxy.handle('chrome-api:tabs:remove' as any, async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    return chrome.tabs.remove(tabId);
  });

  ipcMainProxy.handle('chrome-api:tabs:update' as any, async(_event: Electron.IpcMainInvokeEvent, tabId: string, props: any) => {
    return chrome.tabs.update(tabId, props);
  });

  ipcMainProxy.handle('chrome-api:tabs:reload' as any, async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    return chrome.tabs.reload(tabId);
  });

  ipcMainProxy.handle('chrome-api:tabs:goBack' as any, async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    return chrome.tabs.goBack(tabId);
  });

  ipcMainProxy.handle('chrome-api:tabs:goForward' as any, async(_event: Electron.IpcMainInvokeEvent, tabId: string) => {
    return chrome.tabs.goForward(tabId);
  });

  // ── chrome.scripting ─────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:scripting:executeScript' as any, async(_event: Electron.IpcMainInvokeEvent, injection: any) => {
    // func cannot be serialized over IPC, so renderer must send `code` instead
    return chrome.scripting.executeScript(injection);
  });

  ipcMainProxy.handle('chrome-api:scripting:insertCSS' as any, async(_event: Electron.IpcMainInvokeEvent, injection: any) => {
    return chrome.scripting.insertCSS(injection);
  });

  // ── chrome.cookies ───────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:cookies:get' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.cookies.get(details);
  });

  ipcMainProxy.handle('chrome-api:cookies:getAll' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.cookies.getAll(details || {});
  });

  ipcMainProxy.handle('chrome-api:cookies:set' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.cookies.set(details);
  });

  ipcMainProxy.handle('chrome-api:cookies:remove' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.cookies.remove(details);
  });

  // ── chrome.storage ───────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:storage:local:get' as any, async(_event: Electron.IpcMainInvokeEvent, keys: any) => {
    return chrome.storage.local.get(keys);
  });

  ipcMainProxy.handle('chrome-api:storage:local:set' as any, async(_event: Electron.IpcMainInvokeEvent, items: any) => {
    return chrome.storage.local.set(items);
  });

  ipcMainProxy.handle('chrome-api:storage:local:remove' as any, async(_event: Electron.IpcMainInvokeEvent, keys: any) => {
    return chrome.storage.local.remove(keys);
  });

  // ── chrome.windows ───────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:windows:create' as any, async(_event: Electron.IpcMainInvokeEvent, props: any) => {
    return chrome.windows.create(props);
  });

  ipcMainProxy.handle('chrome-api:windows:remove' as any, async(_event: Electron.IpcMainInvokeEvent, windowId: string) => {
    return chrome.windows.remove(windowId);
  });

  ipcMainProxy.handle('chrome-api:windows:get' as any, async(_event: Electron.IpcMainInvokeEvent, windowId: string) => {
    return chrome.windows.get(windowId);
  });

  // ── chrome.alarms ────────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:alarms:create' as any, async(_event: Electron.IpcMainInvokeEvent, name: string, alarmInfo: any) => {
    return chrome.alarms.create(name, alarmInfo);
  });

  ipcMainProxy.handle('chrome-api:alarms:get' as any, async(_event: Electron.IpcMainInvokeEvent, name: string) => {
    return chrome.alarms.get(name);
  });

  ipcMainProxy.handle('chrome-api:alarms:getAll' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.alarms.getAll();
  });

  ipcMainProxy.handle('chrome-api:alarms:clear' as any, async(_event: Electron.IpcMainInvokeEvent, name: string) => {
    return chrome.alarms.clear(name);
  });

  ipcMainProxy.handle('chrome-api:alarms:clearAll' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.alarms.clearAll();
  });

  // ── chrome.contextMenus ───────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:contextMenus:create' as any, async(_event: Electron.IpcMainInvokeEvent, props: any) => {
    return chrome.contextMenus.create(props);
  });

  ipcMainProxy.handle('chrome-api:contextMenus:update' as any, async(_event: Electron.IpcMainInvokeEvent, id: string, props: any) => {
    return chrome.contextMenus.update(id, props);
  });

  ipcMainProxy.handle('chrome-api:contextMenus:remove' as any, async(_event: Electron.IpcMainInvokeEvent, id: string) => {
    return chrome.contextMenus.remove(id);
  });

  ipcMainProxy.handle('chrome-api:contextMenus:removeAll' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.contextMenus.removeAll();
  });

  // ── chrome.notifications ─────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:notifications:create' as any, async(_event: Electron.IpcMainInvokeEvent, id: string, options: any) => {
    return chrome.notifications.create(id, options);
  });

  ipcMainProxy.handle('chrome-api:notifications:clear' as any, async(_event: Electron.IpcMainInvokeEvent, id: string) => {
    return chrome.notifications.clear(id);
  });

  // ── chrome.commands ──────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:commands:getAll' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.commands.getAll();
  });

  // ── chrome.tts ───────────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:tts:speak' as any, async(_event: Electron.IpcMainInvokeEvent, utterance: string, options?: any) => {
    return chrome.tts.speak(utterance, options);
  });

  ipcMainProxy.handle('chrome-api:tts:stop' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    chrome.tts.stop();
  });

  ipcMainProxy.handle('chrome-api:tts:getVoices' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.tts.getVoices();
  });

  // ── chrome.action ────────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:action:setIcon' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.action.setIcon(details);
  });

  ipcMainProxy.handle('chrome-api:action:setBadgeText' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.action.setBadgeText(details);
  });

  ipcMainProxy.handle('chrome-api:action:setBadgeBackgroundColor' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.action.setBadgeBackgroundColor(details);
  });

  ipcMainProxy.handle('chrome-api:action:setTitle' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.action.setTitle(details);
  });

  ipcMainProxy.handle('chrome-api:action:getState' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.getActionState();
  });

  // ── chrome.downloads ─────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:downloads:download' as any, async(_event: Electron.IpcMainInvokeEvent, options: any) => {
    return chrome.downloads.download(options);
  });

  ipcMainProxy.handle('chrome-api:downloads:search' as any, async(_event: Electron.IpcMainInvokeEvent, query: any) => {
    return chrome.downloads.search(query || {});
  });

  ipcMainProxy.handle('chrome-api:downloads:cancel' as any, async(_event: Electron.IpcMainInvokeEvent, id: string) => {
    return chrome.downloads.cancel(id);
  });

  ipcMainProxy.handle('chrome-api:downloads:pause' as any, async(_event: Electron.IpcMainInvokeEvent, id: string) => {
    return chrome.downloads.pause(id);
  });

  ipcMainProxy.handle('chrome-api:downloads:resume' as any, async(_event: Electron.IpcMainInvokeEvent, id: string) => {
    return chrome.downloads.resume(id);
  });

  // ── chrome.history ───────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:history:search' as any, async(_event: Electron.IpcMainInvokeEvent, query: any) => {
    return chrome.history.search(query);
  });

  ipcMainProxy.handle('chrome-api:history:addUrl' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.history.addUrl(details);
  });

  ipcMainProxy.handle('chrome-api:history:deleteUrl' as any, async(_event: Electron.IpcMainInvokeEvent, details: any) => {
    return chrome.history.deleteUrl(details);
  });

  ipcMainProxy.handle('chrome-api:history:deleteAll' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.history.deleteAll();
  });

  // ── chrome.sidePanel ─────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:sidePanel:open' as any, async(_event: Electron.IpcMainInvokeEvent, options: any) => {
    return chrome.sidePanel.open(options || {});
  });

  ipcMainProxy.handle('chrome-api:sidePanel:close' as any, async(_event: Electron.IpcMainInvokeEvent, options: any) => {
    return chrome.sidePanel.close(options || {});
  });

  ipcMainProxy.handle('chrome-api:sidePanel:setOptions' as any, async(_event: Electron.IpcMainInvokeEvent, options: any) => {
    return chrome.sidePanel.setOptions(options);
  });

  ipcMainProxy.handle('chrome-api:sidePanel:getOptions' as any, async(_event: Electron.IpcMainInvokeEvent) => {
    return chrome.sidePanel.getOptions();
  });

  // ── chrome.runtime ───────────────────────────────────────────────────────

  ipcMainProxy.handle('chrome-api:runtime:sendMessage' as any, async(_event: Electron.IpcMainInvokeEvent, message: any) => {
    return chrome.runtime.sendMessage(message);
  });

  // ── Initialize bridges ───────────────────────────────────────────────────

  // Attach webRequest event bridge to the shared browser session
  // (runs after SullaWebRequestFixer has already attached its handlers)
  chrome.initWebRequestBridge();

  console.log('[ChromeApi] IPC handlers registered');
}
