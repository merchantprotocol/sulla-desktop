import Electron, { BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions, ipcMain, shell } from 'electron';

import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import type { ConversationHistoryRecord } from '@pkg/agent/database/models/ConversationHistoryModel';
import { VMBackend } from '@pkg/backend/backend';
import { State } from '@pkg/backend/k8s';
import mainEvents from '@pkg/main/mainEvents';
import setupUpdate from '@pkg/main/update';
import Logging from '@pkg/utils/logging';
import { openDockerDashboard, openLanguageModelSettings, openAudioSettings, openComputerUseSettings, openCaptureStudio, openMain, openEditor, getWindow, openUrlInApp } from '@pkg/window';
import { openDashboard } from '@pkg/window/dashboard';
import { openPreferences } from '@pkg/window/preferences';

const console = Logging.mainmenu;

// State for dynamic menu updates
let kubernetesState: State = State.STOPPED;
let userLoggedIn = false;

/**
 * Current routine-surface context, pushed from the renderer via
 * `app-state:set-routine-context` whenever the user navigates to or
 * away from a routine/template. Drives enable/disable on the File →
 * Routines submenu items.
 */
type RoutineContext =
  | { mode: 'routine';  id: string;   name: string }
  | { mode: 'template'; slug: string; name: string }
  | null;

let currentRoutineContext: RoutineContext = null;

/** Set by the app-state IPC listener (registered below). */
function setRoutineContext(ctx: RoutineContext): void {
  currentRoutineContext = ctx;
  rebuildMenu();
}

// Listen for context updates from the renderer. Renderers send this
// fire-and-forget whenever the visible surface changes (navigate into
// the editor, open a template, return to the routines home, etc.).
ipcMain.on('app-state:set-routine-context', (_event, ctx: RoutineContext) => {
  setRoutineContext(ctx && typeof ctx === 'object' ? ctx : null);
});

/** Called by vault IPC handlers when lock state changes */
export function setUserLoggedIn(unlocked: boolean): void {
  userLoggedIn = unlocked;
  rebuildMenu();
  // Also update the tray menu
  try {
    const { Tray } = require('./tray');
    const tray = Tray.getInstanceIfExists();
    if (tray) tray.setUserLoggedIn(unlocked);
  } catch { /* tray not initialized yet */ }

  // Broadcast to ALL renderer windows so every login/lock screen reacts
  const channel = unlocked ? 'vault:logged-in' : 'vault:logged-out';

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      sendWhenReady(win, channel, {});
    }
  }
}

export default function buildApplicationMenu(): void {
  const menuItems: MenuItem[] = getApplicationMenu();
  const menu = Menu.buildFromTemplate(menuItems);

  Menu.setApplicationMenu(menu);

  // Set up event listeners for dynamic menu updates
  mainEvents.on('k8s-check-state', (mgr: VMBackend) => {
    kubernetesState = mgr.state;
    rebuildMenu();
  });

  // Rebuild history menu when history changes
  mainEvents.on('conversation-history:changed' as any, () => {
    rebuildMenu();
  });

  // Refresh extensions list for the menu.
  // Listen to the same event the tray uses — 'settings-update' fires reliably
  // whenever extensions change, whereas 'extensions/changed' may not fire.
  refreshExtensions();
  mainEvents.on('extensions/changed' as any, () => refreshExtensions());
  mainEvents.on('settings-update' as any, () => refreshExtensions());
}

function rebuildMenu(): void {
  // Rebuild immediately with whatever we have cached
  const menuItems: MenuItem[] = getApplicationMenu();
  const menu = Menu.buildFromTemplate(menuItems);

  Menu.setApplicationMenu(menu);

  // Then refresh history cache and rebuild again if it changed
  refreshHistoryCache().then(() => {
    const updated: MenuItem[] = getApplicationMenu();
    const updatedMenu = Menu.buildFromTemplate(updated);

    Menu.setApplicationMenu(updatedMenu);
  }).catch(() => {
    // DB not ready — menu already built with stale/empty cache, that's fine
  });
}

function getApplicationMenu(): MenuItem[] {
  switch (process.platform) {
  case 'darwin':
    return getMacApplicationMenu();
  case 'linux':
    return getWindowsApplicationMenu();
  case 'win32':
    return getWindowsApplicationMenu();
  default:
    throw new Error(`Unsupported platform: ${ process.platform }`);
  }
}

function restartApplication(): void {
  console.log('[Shutdown] restartApplication() called — emitting "restarting" event');
  mainEvents.emit('restarting');
  console.log('[Shutdown] "restarting" event emitted, calling app.relaunch() + app.quit()');
  Electron.app.relaunch();
  Electron.app.quit();
}

/**
 * Navigate the main Agent window to a given route path.
 * Opens the main window first if it isn't already visible.
 */
function navigateAgent(routePath: string): void {
  openMain();
  const existing = getWindow('main-agent');

  if (existing) {
    sendWhenReady(existing, 'route', { path: routePath });
  } else {
    const poll = setInterval(() => {
      const window = getWindow('main-agent');

      if (window) {
        clearInterval(poll);
        sendWhenReady(window, 'route', { path: routePath });
      }
    }, 50);
    setTimeout(() => clearInterval(poll), 5000);
  }
}

/**
 * Send a message to a window, waiting for load if necessary.
 */
function sendWhenReady(window: Electron.BrowserWindow, channel: string, data: unknown): void {
  if (!window.webContents.isLoading()) {
    window.webContents.send(channel, data);
  } else {
    window.webContents.once('did-finish-load', () => {
      window.webContents.send(channel, data);
    });
  }
}

/**
 * Send a command to the Agent window renderer (e.g. to create tabs).
 */
function sendAgentCommand(command: string, payload?: Record<string, unknown>): void {
  openMain();
  const existing = getWindow('main-agent');

  if (existing) {
    sendWhenReady(existing, 'agent-command', { command, ...payload });
  } else {
    const poll = setInterval(() => {
      const window = getWindow('main-agent');

      if (window) {
        clearInterval(poll);
        sendWhenReady(window, 'agent-command', { command, ...payload });
      }
    }, 50);
    setTimeout(() => clearInterval(poll), 5000);
  }
}

// ── Dynamic extension data for menu ──

interface ExtensionData {
  version:    string;
  metadata:   any;
  labels:     Record<string, string>;
  extraUrls?: { label: string; url: string }[];
}

let installedExtensions: Record<string, ExtensionData> = {};

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshExtensions(): Promise<void> {
  try {
    const credentials = await mainEvents.invoke('api-get-credentials');

    if (!credentials) {
      // API server not ready yet — retry in a few seconds
      scheduleRetry();

      return;
    }

    const authHeader = `Basic ${ Buffer.from(`${ credentials.user }:${ credentials.password }`).toString('base64') }`;
    const response = await fetch('http://127.0.0.1:6107/v1/extensions', {
      headers: { Authorization: authHeader },
    });

    if (!response.ok) {
      scheduleRetry();

      return;
    }

    installedExtensions = await response.json();
    rebuildMenu();

    // Success — cancel any pending retry
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  } catch {
    // Extensions API may not be available yet — retry
    scheduleRetry();
  }
}

function scheduleRetry(): void {
  if (refreshTimer) return; // already scheduled
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshExtensions();
  }, 5_000);
}

function getExtensionsSubmenu(): MenuItemConstructorOptions[] {
  const entries = Object.entries(installedExtensions);

  if (entries.length === 0) {
    return [{ label: 'No extensions installed', enabled: false }];
  }

  return entries.map(([id, ext]) => {
    const title = ext.labels?.['org.opencontainers.image.title'] || id;
    const urls = ext.extraUrls ?? [];

    if (urls.length === 0) {
      return { label: title, enabled: false };
    }

    return {
      label:   title,
      submenu: urls.map(link => ({
        label: link.label,
        click: () => {
          openUrlInApp(link.url);
        },
      })),
    };
  });
}

/**
 * Navigate the Docker Dashboard window to a given route path.
 * Opens the Docker Dashboard first if it isn't already visible.
 */
function navigateDockerDashboard(routePath: string): void {
  const existing = getWindow('docker-dashboard');

  if (existing) {
    sendWhenReady(existing, 'route', { path: routePath });
    existing.show();
  } else {
    openDockerDashboard();
    const poll = setInterval(() => {
      const window = getWindow('docker-dashboard');

      if (window) {
        clearInterval(poll);
        sendWhenReady(window, 'route', { path: routePath });
      }
    }, 50);
    setTimeout(() => clearInterval(poll), 5000);
  }
}

// ── Menu builders ──

function getFileMenu(): MenuItem {
  return new MenuItem({
    label:   '&File',
    submenu: [
      {
        label:       'New Chat Tab',
        accelerator: 'CmdOrCtrl+N',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('new-chat-tab'),
      },
      {
        label:       'New Browser Tab',
        accelerator: 'CmdOrCtrl+T',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('new-browser-tab'),
      },
      { type: 'separator' },
      {
        label:       'Open Sulla Agent',
        accelerator: 'CmdOrCtrl+1',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('open-tab', { mode: 'chat' }),
      },
      // Hidden: Open Calendar
      // {
      //   label:       'Open Calendar',
      //   accelerator: 'CmdOrCtrl+2',
      //   enabled:     userLoggedIn,
      //   click:       () => sendAgentCommand('open-tab', { mode: 'calendar' }),
      // },
      {
        label:       'Open Integrations',
        accelerator: 'CmdOrCtrl+3',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('open-tab', { mode: 'integrations' }),
      },
      {
        label:       'Open Password Manager',
        accelerator: 'CmdOrCtrl+4',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('open-tab', { mode: 'vault' }),
      },
      {
        label:       'Open Extensions',
        accelerator: 'CmdOrCtrl+5',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('open-tab', { mode: 'extensions' }),
      },
      {
        label:       'Open Routines',
        accelerator: 'CmdOrCtrl+6',
        enabled:     userLoggedIn,
        click:       () => sendAgentCommand('open-tab', { mode: 'routines' }),
      },
      {
        label:   'Routines',
        enabled: userLoggedIn,
        submenu: [
          {
            label:       'Import Routine…',
            accelerator: 'CmdOrCtrl+Shift+I',
            enabled:     userLoggedIn,
            click:       () => sendAgentCommand('routines:import'),
          },
          {
            label:       'Export Current Routine…',
            accelerator: 'CmdOrCtrl+Shift+E',
            enabled:     userLoggedIn && currentRoutineContext?.mode === 'routine',
            click:       () => {
              if (currentRoutineContext?.mode === 'routine') {
                sendAgentCommand('routines:export', { id: currentRoutineContext.id });
              }
            },
          },
        ],
      },
      { type: 'separator' },
      // Hidden: Open Agent Workbench / Open Capture Studio
      // {
      //   label:       'Open Agent Workbench',
      //   accelerator: 'CmdOrCtrl+Shift+E',
      //   enabled:     userLoggedIn,
      //   click:       openEditor,
      // },
      // {
      //   label:       'Open Capture Studio',
      //   accelerator: 'CmdOrCtrl+Shift+R',
      //   enabled:     userLoggedIn,
      //   click:       openCaptureStudio,
      // },
      {
        label:   'Open Docker Dashboard',
        enabled: userLoggedIn,
        click:   openDockerDashboard,
      },
      {
        label:   'Open Cluster Dashboard',
        click:   openDashboard,
        enabled: kubernetesState === State.STARTED && userLoggedIn,
      },
      { type: 'separator' },
      {
        label:   'Diagnostics',
        enabled: userLoggedIn,
        click:   () => navigateDockerDashboard('/Diagnostics'),
      },
      {
        label:   'Troubleshooting',
        enabled: userLoggedIn,
        click:   () => navigateDockerDashboard('/Troubleshooting'),
      },
      { type: 'separator' },
      {
        id:      'extensions-list',
        label:   'Installed Extensions',
        enabled: userLoggedIn,
        submenu: getExtensionsSubmenu(),
      },
      { type: 'separator' },
      { role: 'close', label: 'Close Window' },
    ],
  });
}

function getEditMenu(isMac: boolean): MenuItem {
  return new MenuItem({
    label:   '&Edit',
    submenu: [
      { role: 'undo', label: '&Undo' },
      { role: 'redo', label: '&Redo' },
      { type: 'separator' },
      { role: 'cut', label: 'Cu&t' },
      { role: 'copy', label: '&Copy' },
      { role: 'paste', label: '&Paste' },
      { role: 'delete', label: 'De&lete' },
      ...(!isMac ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
      { role: 'selectAll', label: 'Select &All' },
    ],
  });
}

function getHelpMenu(isMac: boolean): MenuItem {
  const helpMenuItems: MenuItemConstructorOptions[] = [
    ...(!isMac
      ? [
        {
          role:  'about',
          label: `&About ${ Electron.app.name }`,
          click() {
            Electron.app.showAboutPanel();
          },
        } as MenuItemConstructorOptions,
        { type: 'separator' } as MenuItemConstructorOptions,
      ]
      : []),
    {
      label: '&Documentation',
      click() {
        openUrlInApp('https://docs.sulladesktop.com');
      },
    },
    {
      label: '&Release Notes',
      click() {
        openUrlInApp('https://sulladesktop.com/release-notes');
      },
    },
    { type: 'separator' },
    {
      label: 'Report an &Issue…',
      click() {
        openUrlInApp('https://sulladesktop.com/support');
      },
    },
    {
      label: '&Premium Support',
      click() {
        openUrlInApp('https://www.skool.com/book-more-appointments-8103');
      },
    },
    { type: 'separator' },
    {
      label: 'P&roject Page',
      click() {
        openUrlInApp('https://sulladesktop.com');
      },
    },
  ];

  return new MenuItem({
    role:    'help',
    label:   '&Help',
    submenu: helpMenuItems,
  });
}

// ── History menu ──

/** Cached history entries for the menu — refreshed on each build. */
let cachedHistoryEntries: ConversationHistoryRecord[] = [];

/**
 * Refresh cached history entries from the database.
 * Called before building the menu.
 */
async function refreshHistoryCache(): Promise<void> {
  try {
    cachedHistoryEntries = await ConversationHistoryModel.getRecent(100);
  } catch {
    cachedHistoryEntries = [];
  }
}

/**
 * Build a history entry menu item label with a type icon prefix.
 */
function historyEntryLabel(entry: ConversationHistoryRecord): string {
  const icon = entry.type === 'chat' ? '\uD83D\uDCAC' : '\uD83C\uDF10'; // chat bubble or globe
  const title = entry.title || entry.url || 'Untitled';
  const maxLen = 50;
  const truncated = title.length > maxLen ? title.slice(0, maxLen) + '...' : title;

  return `${ icon } ${ truncated }`;
}

/**
 * Build a click handler for a history entry that navigates/reopens in the renderer.
 */
function historyEntryClick(entry: ConversationHistoryRecord): () => void {
  return () => {
    const existing = getWindow('main-agent');

    if (existing) {
      sendWhenReady(existing, 'conversation-history:navigate', {
        id:     entry.id,
        type:   entry.type,
        url:    entry.url,
        title:  entry.title,
        tab_id: entry.tab_id,
      });
    } else {
      openMain();
      const poll = setInterval(() => {
        const window = getWindow('main-agent');

        if (window) {
          clearInterval(poll);
          sendWhenReady(window, 'conversation-history:navigate', {
            id:     entry.id,
            type:   entry.type,
            url:    entry.url,
            title:  entry.title,
            tab_id: entry.tab_id,
          });
        }
      }, 50);
      setTimeout(() => clearInterval(poll), 5000);
    }
  };
}

/**
 * Filter history entries by date range.
 */
function filterByDate(entries: ConversationHistoryRecord[], startOfDay: Date, endOfDay: Date): ConversationHistoryRecord[] {
  return entries.filter((e) => {
    const d = new Date(e.last_active_at || e.created_at);

    return d >= startOfDay && d < endOfDay;
  });
}

function getHistoryMenu(): MenuItem {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekAgoStart = new Date(todayStart.getTime() - 7 * 86_400_000);

  const todayEntries = filterByDate(cachedHistoryEntries, todayStart, todayEnd);
  const yesterdayEntries = filterByDate(cachedHistoryEntries, yesterdayStart, todayStart);
  const last7DaysEntries = filterByDate(cachedHistoryEntries, weekAgoStart, yesterdayStart);

  const submenu: MenuItemConstructorOptions[] = [
    {
      label:       'Show All History',
      accelerator: 'CmdOrCtrl+Y',
      enabled:     userLoggedIn,
      click:       () => {
        const existing = getWindow('main-agent');

        if (existing) {
          sendWhenReady(existing, 'conversation-history:show-all', undefined);
        } else {
          openMain();
        }
      },
    },
    { type: 'separator' },
    {
      label:       'Reopen Last Closed Tab',
      accelerator: 'CmdOrCtrl+Shift+T',
      enabled:     userLoggedIn,
      click:       () => {
        const existing = getWindow('main-agent');

        if (existing) {
          sendWhenReady(existing, 'conversation-history:restore-last-closed', undefined);
        }
      },
    },
    { type: 'separator' },
  ];

  // Today section
  if (todayEntries.length > 0) {
    submenu.push({ label: 'Today', enabled: false });
    for (const entry of todayEntries.slice(0, 10)) {
      submenu.push({
        label:   historyEntryLabel(entry),
        enabled: userLoggedIn,
        click:   historyEntryClick(entry),
      });
    }
    submenu.push({ type: 'separator' });
  }

  // Yesterday section
  if (yesterdayEntries.length > 0) {
    submenu.push({ label: 'Yesterday', enabled: false });
    for (const entry of yesterdayEntries.slice(0, 10)) {
      submenu.push({
        label:   historyEntryLabel(entry),
        enabled: userLoggedIn,
        click:   historyEntryClick(entry),
      });
    }
    submenu.push({ type: 'separator' });
  }

  // Last 7 days submenu
  if (last7DaysEntries.length > 0) {
    submenu.push({
      label:   'Last 7 Days',
      enabled: userLoggedIn,
      submenu: last7DaysEntries.slice(0, 20).map(entry => ({
        label:   historyEntryLabel(entry),
        enabled: userLoggedIn,
        click:   historyEntryClick(entry),
      })),
    });
    submenu.push({ type: 'separator' });
  }

  // Clear History submenu
  submenu.push({
    label:   'Clear History...',
    enabled: userLoggedIn,
    submenu: [
      {
        label:   'Clear Last Hour',
        enabled: userLoggedIn,
        click:   () => {
          const cutoff = new Date(Date.now() - 3_600_000).toISOString();
          const existing = getWindow('main-agent');

          if (existing) {
            sendWhenReady(existing, 'conversation-history:cleared', cutoff);
          }
          // Also trigger main-process clear
          import('./conversationHistoryIpc').catch(() => {});
          mainEvents.emit('conversation-history:clear-request' as any, cutoff);
        },
      },
      {
        label:   'Clear Today',
        enabled: userLoggedIn,
        click:   () => {
          const cutoff = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
          const existing = getWindow('main-agent');

          if (existing) {
            sendWhenReady(existing, 'conversation-history:cleared', cutoff);
          }
          mainEvents.emit('conversation-history:clear-request' as any, cutoff);
        },
      },
      {
        label:   'Clear All History',
        enabled: userLoggedIn,
        click:   () => {
          const existing = getWindow('main-agent');

          if (existing) {
            sendWhenReady(existing, 'conversation-history:cleared', undefined);
          }
          mainEvents.emit('conversation-history:clear-request' as any, undefined);
        },
      },
    ],
  });

  return new MenuItem({
    label: '&History',
    submenu,
  });
}

// ── Platform-specific menus ──

function getMacApplicationMenu(): MenuItem[] {
  return [
    new MenuItem({
      label:   Electron.app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          async click() {
            await setupUpdate(true, false);
          },
        },
        { type: 'separator' },
        {
          label:       'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click:       openPreferences,
        },
        {
          label:       'Language Model Settings…',
          accelerator: 'CmdOrCtrl+L',
          enabled:     userLoggedIn,
          click:       openLanguageModelSettings,
        },
        {
          label:       'Audio Settings…',
          accelerator: 'CmdOrCtrl+Shift+U',
          enabled:     userLoggedIn,
          click:       openAudioSettings,
        },
        {
          label:       'Computer Use Settings\u2026',
          accelerator: 'CmdOrCtrl+Shift+C',
          enabled:     userLoggedIn,
          click:       openComputerUseSettings,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label:       'Restart Sulla Desktop',
          accelerator: 'CmdOrCtrl+Shift+R',
          click:       restartApplication,
        },
        { role: 'quit' },
      ],
    }),
    getFileMenu(),
    getEditMenu(true),
    getHistoryMenu(),
    new MenuItem({
      label:   '&Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'togglefullscreen', label: 'Toggle Full &Screen' },
        { type: 'separator' },
        {
          label:       '&Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click(_item, focusedWindow) {
            adjustZoomLevel(focusedWindow, 0);
          },
        },
        {
          label:       'Zoom &In',
          accelerator: 'CmdOrCtrl+Plus',
          click(_item, focusedWindow) {
            adjustZoomLevel(focusedWindow, 0.5);
          },
        },
        {
          label:       'Zoom &Out',
          accelerator: 'CmdOrCtrl+-',
          click(_item, focusedWindow) {
            adjustZoomLevel(focusedWindow, -0.5);
          },
        },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'reload', label: '&Reload' },
        { role: 'forceReload', label: '&Force Reload' },
        ...(!Electron.app.isPackaged
          ? [
            { type: 'separator' } as MenuItemConstructorOptions,
            {
              label:   'Developer Tools',
              submenu: [{ role: 'toggleDevTools', label: 'Toggle &Developer Tools' }],
            } as MenuItemConstructorOptions,
          ]
          : []),
      ],
    }),
    new MenuItem({
      label:   'Profile',
      submenu: [
        {
          label:   'My Account',
          enabled: userLoggedIn,
          click:   () => sendAgentCommand('open-tab', { mode: 'account' }),
        },
        { type: 'separator' },
        {
          label:       'Log Out',
          accelerator: 'CmdOrCtrl+Shift+Q',
          click:       async() => {
            try {
              // UI logout — lock menus and show lock screen, but keep VMK for agent
              // setUserLoggedIn broadcasts vault:logged-out to all windows
              setUserLoggedIn(false);
            } catch (err) {
              console.error('[MainMenu] Logout failed:', err);
            }
          },
        },
      ],
    }),
    getHelpMenu(true),
  ];
}

function getWindowsApplicationMenu(): MenuItem[] {
  return [
    new MenuItem({
      label:   '&File',
      submenu: [
        {
          label:       'New &Chat Tab',
          accelerator: 'CmdOrCtrl+N',
          click:       () => sendAgentCommand('new-chat-tab'),
        },
        {
          label:       'New &Browser Tab',
          accelerator: 'CmdOrCtrl+T',
          click:       () => sendAgentCommand('new-browser-tab'),
        },
        { type: 'separator' },
        {
          label: 'Open Sulla Agent',
          click: () => sendAgentCommand('open-tab', { mode: 'chat' }),
        },
        // Hidden: Open Calendar
        // {
        //   label: 'Open Calendar',
        //   click: () => sendAgentCommand('open-tab', { mode: 'calendar' }),
        // },
        {
          label: 'Open Integrations',
          click: () => sendAgentCommand('open-tab', { mode: 'integrations' }),
        },
        {
          label: 'Open Password Manager',
          click: () => sendAgentCommand('open-tab', { mode: 'vault' }),
        },
        {
          label: 'Open Extensions',
          click: () => sendAgentCommand('open-tab', { mode: 'extensions' }),
        },
        {
          label: 'Open Routines',
          click: () => sendAgentCommand('open-tab', { mode: 'routines' }),
        },
        { type: 'separator' },
        // Hidden: Open Agent Workbench
        // {
        //   label:       'Open Agent Workbench',
        //   accelerator: 'CmdOrCtrl+Shift+E',
        //   click:       openEditor,
        // },
        {
          label: 'Open Docker Dashboard',
          click: openDockerDashboard,
        },
        {
          label:   'Open Cluster Dashboard',
          click:   openDashboard,
          enabled: kubernetesState === State.STARTED,
        },
        { type: 'separator' },
        {
          id:      'extensions-list',
          label:   'Installed Extensions',
          submenu: getExtensionsSubmenu(),
        },
        { type: 'separator' },
        {
          label:       '&Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click:       openPreferences,
        },
        { type: 'separator' },
        {
          label:       '&Restart',
          accelerator: 'CmdOrCtrl+Shift+R',
          click:       restartApplication,
        },
        {
          role:  'quit',
          label: 'E&xit',
        },
      ],
    }),
    getEditMenu(false),
    getHistoryMenu(),
    getHelpMenu(false),
  ];
}

/**
 * Adjusts the zoom level for the focused window by the desired increment.
 * Also emits an IPC request to the webContents to trigger a resize of the
 * extensions view.
 */
function adjustZoomLevel(focusedWindow: Electron.BaseWindow | undefined, zoomLevelAdjustment: number) {
  if (!focusedWindow || !(focusedWindow instanceof Electron.BrowserWindow)) {
    return;
  }

  const { webContents } = focusedWindow;
  const currentZoomLevel = webContents.getZoomLevel();
  const desiredZoomLevel = zoomLevelAdjustment === 0 ? zoomLevelAdjustment : currentZoomLevel + zoomLevelAdjustment;

  webContents.setZoomLevel(desiredZoomLevel);

  // Also sync the zoom level of any child views (e.g. the extensions view in
  // the main window).
  for (const child of focusedWindow.contentView.children) {
    if (child instanceof Electron.WebContentsView) {
      child.webContents.setZoomLevel(desiredZoomLevel);
    }
  }
  // For the main window, this triggers resizing the extensions view.
  setImmediate(() => webContents.send('extensions/getContentArea'));
}
