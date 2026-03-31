/**
 * IPC handler registration for the chrome.* API.
 *
 * Exposes chrome.tabs, chrome.scripting, chrome.cookies, chrome.storage,
 * chrome.windows, and chrome.runtime to renderer processes via IPC invoke.
 *
 * Channel naming convention: 'chrome-api:<namespace>:<method>'
 *
 * Uses Electron.ipcMain directly (not ipcMainProxy) because these channels
 * are not registered in IpcMainInvokeEvents and the typed proxy rejects
 * handler signatures with typed parameters.
 */

import Electron from 'electron';

import Logging from '@pkg/utils/logging';
import { getChromeApi } from './ChromeApiService';

const console = Logging.sulla;
const { ipcMain } = Electron;

export function initChromeApiIpc(): void {
  const chrome = getChromeApi();

  // ── chrome.tabs ──────────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:tabs:get', async(_event, tabId: string) => {
    return chrome.tabs.get(tabId);
  });

  ipcMain.handle('chrome-api:tabs:query', async(_event, queryInfo: any) => {
    return chrome.tabs.query(queryInfo || {});
  });

  ipcMain.handle('chrome-api:tabs:create', async(_event, props: any) => {
    return chrome.tabs.create(props);
  });

  ipcMain.handle('chrome-api:tabs:remove', async(_event, tabId: string) => {
    return chrome.tabs.remove(tabId);
  });

  ipcMain.handle('chrome-api:tabs:update', async(_event, tabId: string, props: any) => {
    return chrome.tabs.update(tabId, props);
  });

  ipcMain.handle('chrome-api:tabs:reload', async(_event, tabId: string) => {
    return chrome.tabs.reload(tabId);
  });

  ipcMain.handle('chrome-api:tabs:goBack', async(_event, tabId: string) => {
    return chrome.tabs.goBack(tabId);
  });

  ipcMain.handle('chrome-api:tabs:goForward', async(_event, tabId: string) => {
    return chrome.tabs.goForward(tabId);
  });

  // ── chrome.scripting ─────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:scripting:executeScript', async(_event, injection: any) => {
    // func cannot be serialized over IPC, so renderer must send `code` instead
    return chrome.scripting.executeScript(injection);
  });

  ipcMain.handle('chrome-api:scripting:insertCSS', async(_event, injection: any) => {
    return chrome.scripting.insertCSS(injection);
  });

  // ── chrome.cookies ───────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:cookies:get', async(_event, details: any) => {
    return chrome.cookies.get(details);
  });

  ipcMain.handle('chrome-api:cookies:getAll', async(_event, details: any) => {
    return chrome.cookies.getAll(details || {});
  });

  ipcMain.handle('chrome-api:cookies:set', async(_event, details: any) => {
    return chrome.cookies.set(details);
  });

  ipcMain.handle('chrome-api:cookies:remove', async(_event, details: any) => {
    return chrome.cookies.remove(details);
  });

  // ── chrome.storage ───────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:storage:local:get', async(_event, keys: any) => {
    return chrome.storage.local.get(keys);
  });

  ipcMain.handle('chrome-api:storage:local:set', async(_event, items: any) => {
    return chrome.storage.local.set(items);
  });

  ipcMain.handle('chrome-api:storage:local:remove', async(_event, keys: any) => {
    return chrome.storage.local.remove(keys);
  });

  // ── chrome.windows ───────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:windows:create', async(_event, props: any) => {
    return chrome.windows.create(props);
  });

  ipcMain.handle('chrome-api:windows:remove', async(_event, windowId: string) => {
    return chrome.windows.remove(windowId);
  });

  ipcMain.handle('chrome-api:windows:get', async(_event, windowId: string) => {
    return chrome.windows.get(windowId);
  });

  // ── chrome.alarms ────────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:alarms:create', async(_event, name: string, alarmInfo: any) => {
    return chrome.alarms.create(name, alarmInfo);
  });

  ipcMain.handle('chrome-api:alarms:get', async(_event, name: string) => {
    return chrome.alarms.get(name);
  });

  ipcMain.handle('chrome-api:alarms:getAll', async(_event) => {
    return chrome.alarms.getAll();
  });

  ipcMain.handle('chrome-api:alarms:clear', async(_event, name: string) => {
    return chrome.alarms.clear(name);
  });

  ipcMain.handle('chrome-api:alarms:clearAll', async(_event) => {
    return chrome.alarms.clearAll();
  });

  // ── chrome.contextMenus ───────────────────────────────────────────────────

  ipcMain.handle('chrome-api:contextMenus:create', async(_event, props: any) => {
    return chrome.contextMenus.create(props);
  });

  ipcMain.handle('chrome-api:contextMenus:update', async(_event, id: string, props: any) => {
    return chrome.contextMenus.update(id, props);
  });

  ipcMain.handle('chrome-api:contextMenus:remove', async(_event, id: string) => {
    return chrome.contextMenus.remove(id);
  });

  ipcMain.handle('chrome-api:contextMenus:removeAll', async(_event) => {
    return chrome.contextMenus.removeAll();
  });

  // ── chrome.notifications ─────────────────────────────────────────────────

  ipcMain.handle('chrome-api:notifications:create', async(_event, id: string, options: any) => {
    return chrome.notifications.create(id, options);
  });

  ipcMain.handle('chrome-api:notifications:clear', async(_event, id: string) => {
    return chrome.notifications.clear(id);
  });

  // ── chrome.commands ──────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:commands:getAll', async(_event) => {
    return chrome.commands.getAll();
  });

  // ── chrome.tts ───────────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:tts:speak', async(_event, utterance: string, options?: any) => {
    return chrome.tts.speak(utterance, options);
  });

  ipcMain.handle('chrome-api:tts:stop', async(_event) => {
    chrome.tts.stop();
  });

  ipcMain.handle('chrome-api:tts:getVoices', async(_event) => {
    return chrome.tts.getVoices();
  });

  // ── chrome.action ────────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:action:setIcon', async(_event, details: any) => {
    return chrome.action.setIcon(details);
  });

  ipcMain.handle('chrome-api:action:setBadgeText', async(_event, details: any) => {
    return chrome.action.setBadgeText(details);
  });

  ipcMain.handle('chrome-api:action:setBadgeBackgroundColor', async(_event, details: any) => {
    return chrome.action.setBadgeBackgroundColor(details);
  });

  ipcMain.handle('chrome-api:action:setTitle', async(_event, details: any) => {
    return chrome.action.setTitle(details);
  });

  ipcMain.handle('chrome-api:action:getState', async(_event) => {
    return chrome.getActionState();
  });

  // ── chrome.downloads ─────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:downloads:download', async(_event, options: any) => {
    return chrome.downloads.download(options);
  });

  ipcMain.handle('chrome-api:downloads:search', async(_event, query: any) => {
    return chrome.downloads.search(query || {});
  });

  ipcMain.handle('chrome-api:downloads:cancel', async(_event, id: string) => {
    return chrome.downloads.cancel(id);
  });

  ipcMain.handle('chrome-api:downloads:pause', async(_event, id: string) => {
    return chrome.downloads.pause(id);
  });

  ipcMain.handle('chrome-api:downloads:resume', async(_event, id: string) => {
    return chrome.downloads.resume(id);
  });

  // ── chrome.history ───────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:history:search', async(_event, query: any) => {
    return chrome.history.search(query);
  });

  ipcMain.handle('chrome-api:history:addUrl', async(_event, details: any) => {
    return chrome.history.addUrl(details);
  });

  ipcMain.handle('chrome-api:history:deleteUrl', async(_event, details: any) => {
    return chrome.history.deleteUrl(details);
  });

  ipcMain.handle('chrome-api:history:deleteAll', async(_event) => {
    return chrome.history.deleteAll();
  });

  // ── chrome.sidePanel ─────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:sidePanel:open', async(_event, options: any) => {
    return chrome.sidePanel.open(options || {});
  });

  ipcMain.handle('chrome-api:sidePanel:close', async(_event, options: any) => {
    return chrome.sidePanel.close(options || {});
  });

  ipcMain.handle('chrome-api:sidePanel:setOptions', async(_event, options: any) => {
    return chrome.sidePanel.setOptions(options);
  });

  ipcMain.handle('chrome-api:sidePanel:getOptions', async(_event) => {
    return chrome.sidePanel.getOptions();
  });

  // ── chrome.runtime ───────────────────────────────────────────────────────

  ipcMain.handle('chrome-api:runtime:sendMessage', async(_event, message: any) => {
    return chrome.runtime.sendMessage(message);
  });

  console.log('[ChromeApi] IPC handlers registered');
}
