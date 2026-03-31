import Electron, { Menu, MenuItem, MenuItemConstructorOptions, shell } from 'electron';

import { VMBackend } from '@pkg/backend/backend';
import { State } from '@pkg/backend/k8s';
import mainEvents from '@pkg/main/mainEvents';
import Logging from '@pkg/utils/logging';
import setupUpdate from '@pkg/main/update';
import { openDockerDashboard, openLanguageModelSettings, openAudioSettings, openMain, openEditor, getWindow } from '@pkg/window';
import { openDashboard } from '@pkg/window/dashboard';
import { openPreferences } from '@pkg/window/preferences';

const console = Logging.mainmenu;

// State for dynamic menu updates
let kubernetesState: State = State.STOPPED;

export default function buildApplicationMenu(): void {
  const menuItems: MenuItem[] = getApplicationMenu();
  const menu = Menu.buildFromTemplate(menuItems);

  Menu.setApplicationMenu(menu);

  // Set up event listeners for dynamic menu updates
  mainEvents.on('k8s-check-state', (mgr: VMBackend) => {
    kubernetesState = mgr.state;
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
  const menuItems: MenuItem[] = getApplicationMenu();
  const menu = Menu.buildFromTemplate(menuItems);

  Menu.setApplicationMenu(menu);
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
          void shell.openExternal(link.url);
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
        click:       () => sendAgentCommand('new-chat-tab'),
      },
      {
        label:       'New Browser Tab',
        accelerator: 'CmdOrCtrl+T',
        click:       () => sendAgentCommand('new-browser-tab'),
      },
      { type: 'separator' },
      {
        label:       'Open Sulla Agent',
        accelerator: 'CmdOrCtrl+O',
        click:       openMain,
      },
      {
        label:       'Open Agent Workbench',
        accelerator: 'CmdOrCtrl+Shift+E',
        click:       openEditor,
      },
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
      { type: 'separator' },
      {
        id:      'extensions-list',
        label:   'Installed Extensions',
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

function getViewMenu(): MenuItem {
  const devToolsSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload', label: '&Reload' },
    { role: 'forceReload', label: '&Force Reload' },
    { role: 'toggleDevTools', label: 'Toggle &Developer Tools' },
  ];

  return new MenuItem({
    label:   '&View',
    submenu: [
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
      { role: 'togglefullscreen', label: 'Toggle Full &Screen' },
      ...(!Electron.app.isPackaged
        ? [
          { type: 'separator' } as MenuItemConstructorOptions,
          {
            label:   'Developer Tools',
            submenu: devToolsSubmenu,
          } as MenuItemConstructorOptions,
        ]
        : []),
    ],
  });
}

function getGoMenu(): MenuItem {
  return new MenuItem({
    label:   '&Go',
    submenu: [
      {
        label:       '&Agent',
        accelerator: 'CmdOrCtrl+1',
        click:       () => navigateAgent('/Chat'),
      },
      {
        label:       '&Calendar',
        accelerator: 'CmdOrCtrl+2',
        click:       () => sendAgentCommand('open-tab', { mode: 'calendar' }),
      },
      {
        label:       'A&utomations',
        accelerator: 'CmdOrCtrl+3',
        click:       () => navigateAgent('/Automations'),
      },
      {
        label:       '&Integrations',
        accelerator: 'CmdOrCtrl+4',
        click:       () => sendAgentCommand('open-tab', { mode: 'integrations' }),
      },
      {
        label:       'E&xtensions',
        accelerator: 'CmdOrCtrl+5',
        click:       () => sendAgentCommand('open-tab', { mode: 'extensions' }),
      },
      { type: 'separator' },
      {
        label:       '&Language Model Settings…',
        accelerator: 'CmdOrCtrl+L',
        click:       openLanguageModelSettings,
      },
      {
        label:       'A&udio Settings…',
        accelerator: 'CmdOrCtrl+Shift+U',
        click:       openAudioSettings,
      },
      { type: 'separator' },
      {
        label: '&Diagnostics',
        click: () => navigateDockerDashboard('/Diagnostics'),
      },
      {
        label: '&Troubleshooting',
        click: () => navigateDockerDashboard('/Troubleshooting'),
      },
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
        shell.openExternal('https://docs.sulladesktop.com');
      },
    },
    {
      label: '&Release Notes',
      click() {
        shell.openExternal('https://sulladesktop.com/release-notes');
      },
    },
    { type: 'separator' },
    {
      label: 'Report an &Issue…',
      click() {
        shell.openExternal('https://sulladesktop.com/support');
      },
    },
    {
      label: '&Premium Support',
      click() {
        shell.openExternal('https://www.skool.com/book-more-appointments-8103');
      },
    },
    { type: 'separator' },
    {
      label: 'P&roject Page',
      click() {
        shell.openExternal('https://sulladesktop.com');
      },
    },
  ];

  return new MenuItem({
    role:    'help',
    label:   '&Help',
    submenu: helpMenuItems,
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
    getViewMenu(),
    getGoMenu(),
    new MenuItem({
      label:   '&Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Calendar',
          click: () => sendAgentCommand('open-tab', { mode: 'calendar' }),
        },
        {
          label: 'Password Manager',
          click: () => sendAgentCommand('open-tab', { mode: 'vault' }),
        },
        {
          label: 'Extensions',
          click: () => sendAgentCommand('open-tab', { mode: 'extensions' }),
        },
        { type: 'separator' },
        { role: 'front' },
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
          label:       '&Open Sulla Agent',
          accelerator: 'CmdOrCtrl+O',
          click:       openMain,
        },
        {
          label:       'Open Agent &Workbench',
          accelerator: 'CmdOrCtrl+Shift+E',
          click:       openEditor,
        },
        {
          label: 'Open &Docker Dashboard',
          click: openDockerDashboard,
        },
        {
          label:   'Open C&luster Dashboard',
          click:   openDashboard,
          enabled: kubernetesState === State.STARTED,
        },
        { type: 'separator' },
        {
          label: 'Ca&lendar',
          click: () => sendAgentCommand('open-tab', { mode: 'calendar' }),
        },
        {
          label: '&Integrations',
          click: () => sendAgentCommand('open-tab', { mode: 'integrations' }),
        },
        {
          label: 'E&xtensions',
          click: () => sendAgentCommand('open-tab', { mode: 'extensions' }),
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
    getViewMenu(),
    getGoMenu(),
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
