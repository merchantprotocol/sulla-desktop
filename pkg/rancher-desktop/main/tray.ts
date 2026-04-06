// This import is for the tray found in the menu bar (upper right on macos or
// lower right on Windows).

import fs from 'fs';
import os from 'os';
import path from 'path';

import { KubeConfig } from '@kubernetes/client-node';
import Electron from 'electron';

import { VMBackend } from '@pkg/backend/backend';
import { State } from '@pkg/backend/k8s';
import * as kubeconfig from '@pkg/backend/kubeconfig';
import { Settings } from '@pkg/config/settings';
import { showErrorDialogWithReport } from '@pkg/main/errorReporter';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import mainEvents from '@pkg/main/mainEvents';
import { checkConnectivity } from '@pkg/main/networking';
import { createTrayPanel, toggleTrayPanel, sendPanelState, sendAuthState, sendSettingsState, destroyTrayPanel } from '@pkg/main/trayPanel';
import setupUpdate from '@pkg/main/update';
import Logging from '@pkg/utils/logging';
import { networkStatus } from '@pkg/utils/networks';
import paths from '@pkg/utils/paths';
import { openMain, send, openEditor, openDockerDashboard, getWindow, openUrlInApp } from '@pkg/window';
import { openDashboard } from '@pkg/window/dashboard';
import { openPreferences } from '@pkg/window/preferences';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

/**
 * Tray is a class to manage the tray icon for rancher-desktop.
 */
export class Tray {
  protected trayMenu:              Electron.Tray;
  protected backendIsLocked = '';
  protected kubernetesState = State.STOPPED;
  protected userLoggedIn = false;
  private settings:                Settings;
  private currentNetworkStatus:    networkStatus = networkStatus.CHECKING;
  private static instance:         Tray;
  private networkState:            boolean | undefined;
  private runBuildFromConfigTimer: NodeJS.Timeout | null = null;
  private kubeConfigWatchers:      fs.FSWatcher[] = [];
  private fsWatcherInterval:       NodeJS.Timeout;

  /**
   * @deprecated This native context menu is no longer displayed. The tray uses
   * a custom HTML panel (trayPanel/) instead. This array is kept temporarily
   * because updateMenu() mutates it to track state (enabled/disabled, labels)
   * before forwarding to sendPanelState(). It should be replaced with a
   * dedicated state object that the panel reads directly.
   */
  protected contextMenuItems: Electron.MenuItemConstructorOptions[] = [
    {
      id:    'main',
      label: 'Open Sulla',
      icon:  path.join(paths.resources, 'icons', 'logo-tray-Template@2x.png'),
      type:  'normal',
      click() {
        openMain();
      },
    },
{
      id:    'editor',
      label: 'Open Agent Workbench',
      icon:  path.join(paths.resources, 'icons', 'book-open-16.png'),
      type:  'normal',
      click() {
        openEditor();
      },
    },
    {
      id:    'secretary-mode',
      label: 'Secretary Mode',
      icon:  path.join(paths.resources, 'icons', 'automation-play.png'),
      type:  'normal',
      click() {
        openMain();
        const agentWindow = getWindow('main-agent');

        if (agentWindow) {
          const sendCommand = () => agentWindow.webContents.send('agent-command', { command: 'new-secretary-tab' });

          if (agentWindow.webContents.isLoading()) {
            agentWindow.webContents.once('did-finish-load', sendCommand);
          } else {
            sendCommand();
          }
        }
      },
    },
    { type: 'separator' },
    {
      id:      'extensions',
      label:   'Extensions',
      submenu: [{ label: 'No extensions installed', enabled: false }],
    },
    { type: 'separator' },
    {
      id:    'docker-dashboard',
      label: 'Docker Dashboard',
      icon:  path.join(paths.resources, 'icons', 'logo-tray-Template@2x.png'),
      type:  'normal',
      click() {
        openDockerDashboard();
      },
    },
    {
      id:      'dashboard',
      label:   'Cluster Dashboard',
      icon:    path.join(paths.resources, 'icons', 'kubernetes-icon-color.png'),
      type:    'normal',
      enabled: false,
      click() {
        openDashboard();
      },
    },
    { type: 'separator' },
    {
      id:      'help',
      label:   'Help',
      icon:    path.join(paths.resources, 'icons', 'help-circle-16.png'),
      submenu: [
        {
          id:    'premium-support',
          label: 'Premium Support',
          icon:  path.join(paths.resources, 'icons', 'star-16.png'),
          click() {
            openUrlInApp('https://www.skool.com/book-more-appointments-8103');
          },
        },
        {
          id:    'documentation',
          label: 'Documentation',
          icon:  path.join(paths.resources, 'icons', 'book-open-16.png'),
          click() {
            openUrlInApp('https://sulladesktop.com/docs');
          },
        },
        {
          id:    'discussions',
          label: 'Discussions',
          icon:  path.join(paths.resources, 'icons', 'messages-circle-16.png'),
          click() {
            openUrlInApp('https://sulladesktop.com/support');
          },
        },
        { type: 'separator' },
        {
          id:    'issues',
          label: 'Issues',
          icon:  path.join(paths.resources, 'icons', 'issue-opened-16.png'),
          click() {
            openUrlInApp('https://sulladesktop.com/support');
          },
        },
        { type: 'separator' },
        {
          id:    'check-for-updates',
          label: 'Check updates',
          icon:  path.join(paths.resources, 'icons', 'refresh-cw-16.png'),
          click: async() => {
            await setupUpdate(true, false);
          },
        },
      ],
    },
    {
      id:    'quit',
      label: 'Quit',
      icon:  path.join(paths.resources, 'icons', 'thin-x-16.png'),
      role:  'quit',
      type:  'normal',
    },
  ];

  private isMacOs = () => {
    return os.platform() === 'darwin';
  };

  private isLinux = () => {
    return os.platform() === 'linux';
  };

  private readonly trayIconsMacOs = {
    stopped:  path.join(paths.resources, 'icons', 'logo-tray-stopped-Template@2x.png'),
    starting: path.join(paths.resources, 'icons', 'logo-tray-starting-Template@2x.png'),
    started:  path.join(paths.resources, 'icons', 'logo-tray-Template@2x.png'),
    stopping: path.join(paths.resources, 'icons', 'logo-tray-stopping-Template@2x.png'),
    error:    path.join(paths.resources, 'icons', 'logo-tray-error-Template@2x.png'),
  };

  private readonly trayIcons = {
    stopped:  '',
    starting: path.join(paths.resources, 'icons', 'logo-square-bw.png'),
    started:  path.join(paths.resources, 'icons', 'logo-square.png'),
    stopping: '',
    error:    path.join(paths.resources, 'icons', 'logo-square-red.png'),
  };

  private readonly trayIconSet = this.isMacOs() ? this.trayIconsMacOs : this.trayIcons;

  /**
   * Watch for changes to the kubeconfig files; when the change event is
   * triggered, close the watcher and restart after a duration (one second).
   */
  private async watchForChanges() {
    for (const watcher of this.kubeConfigWatchers) {
      watcher.close();
    }
    this.kubeConfigWatchers = [];

    const paths = await kubeconfig.getKubeConfigPaths();
    const options: fs.WatchOptions = {
      persistent: false,
      recursive:  !this.isLinux(), // Recursive not implemented in Linux
      encoding:   'utf-8',
    };

    this.kubeConfigWatchers = paths
      .filter(filepath => {
        try {
          fs.accessSync(filepath);
          return true;
        } catch {
          console.debug(`Skipping watch for non-existent kubeconfig: ${ filepath }`);
          return false;
        }
      })
      .map(filepath => fs.watch(filepath, options, async(eventType) => {
        if (eventType === 'rename') {
          try {
            await fs.promises.access(filepath);
          } catch (ex) {
            // File doesn't exist; wait for it to be recreated.
            return;
          }
        }

        // This prevents calling buildFromConfig multiple times in quick succession
        // while making sure that the last file change within the period is processed.
        this.runBuildFromConfigTimer ||= setTimeout(() => {
          this.runBuildFromConfigTimer = null;
          this.buildFromConfig();
        }, 1_000);
      }));
  }

  private constructor(settings: Settings) {
    this.settings = settings;
    this.trayMenu = new Electron.Tray(this.trayIconSet.starting);
    this.trayMenu.setToolTip('Sulla Desktop');
    const menuItem = this.contextMenuItems.find(item => item.id === 'container-engine');

    if (menuItem) {
      menuItem.label = `Container engine: ${ this.settings.containerEngine.name }`;
    }

    // Discover k8s contexts
    try {
      this.updateContexts();
    } catch (err) {
      showErrorDialogWithReport(
        'Error starting the app',
        `Error message: ${ err instanceof Error ? err.message : err }`,
        'tray-updateContexts',
      );
    }

    // ── Custom panel popover (replaces native context menu on left-click) ──
    createTrayPanel();

    this.trayMenu.on('click', (_event, bounds) => {
      toggleTrayPanel(bounds);
    });

    // Right-click still shows a minimal native fallback menu
    const rightClickMenu = Electron.Menu.buildFromTemplate([
      {
        label: 'Show',
        click: () => {
          const bounds = this.trayMenu.getBounds();
          toggleTrayPanel(bounds);
        },
      },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]);
    this.trayMenu.on('right-click', () => {
      this.trayMenu.popUpContextMenu(rightClickMenu);
    });

    // No setContextMenu — it hijacks left-click on macOS.
    // State-driven icon changes still work via updateMenu().
    this.buildFromConfig();
    this.watchForChanges();

    // We reset the watchers on an interval in the event that `fs.watch` silently
    // fails to keep watching. This original issue is documented at
    // https://github.com/rancher-sandbox/rancher-desktop/pull/2038 and further discussed at
    // https://github.com/rancher-sandbox/rancher-desktop/pull/7238#discussion_r1690128729
    this.fsWatcherInterval = setInterval(() => this.watchForChanges(), 5 * 60_000);

    mainEvents.on('backend-locked-update', this.backendStateEvent);
    mainEvents.emit('backend-locked-check');
    mainEvents.on('k8s-check-state', this.k8sStateChangedEvent);
    mainEvents.on('settings-update', this.settingsUpdateEvent);

    // Refresh the Extensions submenu when extensions change
    mainEvents.on('settings-update', () => {
      this.refreshExtensionsMenu();
    });
    this.refreshExtensionsMenu();

    // If the network connectivity diagnostic changes results, update it here.
    mainEvents.on('diagnostics-event', payload => {
      if (payload.id !== 'network-connectivity') {
        return;
      }

      const { connected } = payload;

      if (this.networkState === connected) {
        return; // network state hasn't changed since last check
      }

      this.networkState = connected;

      this.handleUpdateNetworkStatus(this.networkState).catch((err: any) => {
        console.log('Error updating network status: ', err);
      });
    });
  }

  private backendStateEvent = (backendIsLocked: string) => {
    this.backendStateChanged(backendIsLocked);
  };

  private k8sStateChangedEvent = (mgr: VMBackend) => {
    this.k8sStateChanged(mgr.state);
  };

  private settingsUpdateEvent = (cfg: Settings) => {
    this.settings = cfg;
    this.settingsChanged();
    sendSettingsState({
      autoStart:         cfg.application.autoStart,
      startInBackground: cfg.application.startInBackground,
    });
  };

  private updateNetworkStatusEvent = (_: Electron.IpcMainEvent, status: boolean) => {
    this.handleUpdateNetworkStatus(status).catch((err:any) => {
      console.log('Error updating network status: ', err);
    });
  };

  /**
   * Checks for an existing instance of Tray. If one does not
   * exist, instantiate a new one.
   */
  public static getInstance(settings: Settings): Tray {
    Tray.instance ??= new Tray(settings);

    return Tray.instance;
  }

  /** Update vault lock state and rebuild tray menu */
  public setUserLoggedIn(unlocked: boolean): void {
    this.userLoggedIn = unlocked;
    this.updateMenu();
    sendAuthState({ loggedIn: unlocked, vaultSetUp: true });
  }

  /** Get the singleton without requiring settings (for vault state updates) */
  public static getInstanceIfExists(): Tray | null {
    return Tray.instance || null;
  }

  /**
   * Hide the tray menu.
   */
  public hide() {
    destroyTrayPanel();
    this.trayMenu.destroy();
    mainEvents.off('k8s-check-state', this.k8sStateChangedEvent);
    mainEvents.off('settings-update', this.settingsUpdateEvent);
    ipcMainProxy.removeListener('update-network-status', this.updateNetworkStatusEvent);
    clearInterval(this.fsWatcherInterval);
    if (this.runBuildFromConfigTimer) {
      clearTimeout(this.runBuildFromConfigTimer);
      this.runBuildFromConfigTimer = null;
    }
    for (const watcher of this.kubeConfigWatchers) {
      watcher.close();
    }
    this.kubeConfigWatchers = [];
  }

  /**
   * Show the tray menu.
   */
  public show() {
    if (this.trayMenu.isDestroyed()) {
      Tray.instance = new Tray(this.settings);
    }
  }

  protected async handleUpdateNetworkStatus(status: boolean) {
    if (!status) {
      this.currentNetworkStatus = networkStatus.OFFLINE;
    } else {
      this.currentNetworkStatus = await checkConnectivity('k3s.io') ? networkStatus.CONNECTED : networkStatus.OFFLINE;
    }
    mainEvents.emit('update-network-status', this.currentNetworkStatus === networkStatus.CONNECTED);
    send('update-network-status', this.currentNetworkStatus === networkStatus.CONNECTED);
    this.updateMenu();
  }

  protected buildFromConfig() {
    try {
      this.updateContexts();
    } catch (err) {
      console.log(`Error trying to update context menu: ${ err }`);
    }
  }

  protected backendStateChanged(backendIsLocked: string) {
    this.backendIsLocked = backendIsLocked;
    this.updateMenu();
  }

  /**
   * Called when the Kubernetes cluster state has changed.
   * @param state The new cluster state.
   */
  protected k8sStateChanged(state: State) {
    this.kubernetesState = state;
    this.updateMenu();
  }

  /**
   * Called when the application settings have changed.
   */
  protected settingsChanged() {
    this.updateMenu();
  }

  protected updateMenu() {
    if (this.trayMenu.isDestroyed()) {
      return;
    }

    const labels = {
      [State.STOPPED]:  'Kubernetes is stopped',
      [State.STARTING]: 'Kubernetes is starting',
      [State.STARTED]:  'Kubernetes is running',
      [State.STOPPING]: 'Kubernetes is shutting down',
      [State.ERROR]:    'Kubernetes has encountered an error',
      [State.DISABLED]: 'Kubernetes is disabled',
    };

    let icon = path.join(paths.resources, 'icons', 'kubernetes-icon-black.png');
    let logo = this.trayIconSet.starting;

    if (this.kubernetesState === State.STARTED || this.kubernetesState === State.DISABLED) {
      icon = path.join(paths.resources, 'icons', 'kubernetes-icon-color.png');
      logo = this.trayIconSet.started;
      // Update the contexts as a new kubernetes context will be added
      this.updateContexts();
      this.contextMenuItems = this.updateDashboardState(
        this.kubernetesState === State.STARTED &&
        this.settings.kubernetes.enabled,
      );
    } else if (this.kubernetesState === State.ERROR) {
      // For licensing reasons, we cannot just tint the Kubernetes logo.
      // Here we're using an icon from GitHub's octicons set.
      icon = path.join(paths.resources, 'icons', 'issue-opened-16.png');
      logo = this.trayIconSet.error;
    }

    const stateMenu = this.contextMenuItems.find(item => item.id === 'state');

    if (stateMenu) {
      stateMenu.label = labels[this.kubernetesState] || labels[State.ERROR];
      stateMenu.icon = icon;
    }

    const containerEngineMenu = this.contextMenuItems.find(item => item.id === 'container-engine');

    if (containerEngineMenu) {
      const containerEngine = this.settings.containerEngine.name;

      containerEngineMenu.label = containerEngine === 'containerd' ? containerEngine : `dockerd (${ containerEngine })`;
      containerEngineMenu.icon = containerEngine === 'containerd' ? path.join(paths.resources, 'icons', 'containerd-icon-color.png') : '';
    }
    const networkStatusItem = this.contextMenuItems.find(item => item.id === 'network-status');

    if (networkStatusItem) {
      networkStatusItem.label = `Network status: ${ this.currentNetworkStatus }`;
    }

    this.contextMenuItems
      .filter(item => item.id && ['preferences', 'dashboard', 'contexts', 'quit'].includes(item.id))
      .forEach((item) => {
        item.enabled = !this.backendIsLocked;
      });

    // Lock/unlock items based on vault login state
    if (!this.userLoggedIn) {
      const alwaysEnabled = new Set(['quit', 'help', 'main']);
      this.contextMenuItems.forEach((item) => {
        if (item.id && !alwaysEnabled.has(item.id)) {
          item.enabled = false;
        }
      });
    } else {
      // Re-enable items that were disabled when logged out
      const loginControlled = new Set(['editor', 'docker-dashboard', 'extensions', 'secretary-mode']);
      this.contextMenuItems.forEach((item) => {
        if (item.id && loginControlled.has(item.id)) {
          item.enabled = true;
        }
      });
    }

    this.trayMenu.setImage(logo);

    // Forward state to the custom panel
    sendPanelState({
      docker: this.kubernetesState === State.STARTED ? 'STARTED' : 'STOPPED',
      k8s:    State[this.kubernetesState] || 'STOPPED',
    });
  }

  protected updateDashboardState = (enabled = true) => this.contextMenuItems
    .map(item => item.id === 'dashboard' ? { ...item, enabled } : item);

  /**
   * Update the list of Kubernetes contexts in the tray menu.
   * This does _not_ raise any exceptions if we fail to read the config.
   */
  protected updateContexts() {
    const kc = new KubeConfig();

    try {
      kc.loadFromDefault();
    } catch (ex) {
      console.error('Failed to load kubeconfig, ignoring:', ex);
      // Keep going, with no context set.
    }

    const contextsMenu = this.contextMenuItems.find(item => item.id === 'contexts');
    const curr = kc.getCurrentContext();
    const ctxs = kc.getContexts();

    if (!contextsMenu) {
      return;
    }
    if (ctxs.length === 0) {
      contextsMenu.submenu = [{ label: 'None found' }];
    } else {
      contextsMenu.submenu = ctxs.map(val => ({
        label:   val.name,
        type:    'checkbox',
        click:   menuItem => this.contextClick(menuItem),
        checked: (val.name === curr),
      }));
    }
  }

  /**
   * Call back when a menu item is clicked to change the active Kubernetes context.
   * @param {Electron.MenuItem} menuItem The menu item that was clicked.
   */
  protected contextClick(menuItem: Electron.MenuItem) {
    kubeconfig.setCurrentContext(menuItem.label, () => {
      this.updateContexts();
    });
  }

  /**
   * Refresh the Extensions submenu from the backend API.
   * Each installed extension with extraUrls gets a submenu entry;
   * hovering over the extension name shows its registered URLs.
   */
  protected async refreshExtensionsMenu(): Promise<void> {
    try {
      const credentials = await mainEvents.invoke('api-get-credentials');

      if (!credentials) {
        return;
      }

      const authHeader = `Basic ${ Buffer.from(`${ credentials.user }:${ credentials.password }`).toString('base64') }`;
      const response = await fetch('http://127.0.0.1:6107/v1/extensions', {
        headers: { Authorization: authHeader },
      });

      if (!response.ok) {
        return;
      }

      const data: Record<string, {
        version:    string;
        metadata:   any;
        labels:     Record<string, string>;
        extraUrls?: { label: string; url: string }[];
      }> = await response.json();

      const extensionsMenu = this.contextMenuItems.find(item => item.id === 'extensions');

      if (!extensionsMenu) {
        return;
      }

      const entries = Object.entries(data);

      if (entries.length === 0) {
        extensionsMenu.submenu = [{ label: 'No extensions installed', enabled: false }];
      } else {
        extensionsMenu.submenu = entries.map(([id, ext]) => {
          const title = ext.labels?.['org.opencontainers.image.title'] || id;
          const urls = ext.extraUrls ?? [];

          if (urls.length === 0) {
            return {
              label:   title,
              enabled: false,
            };
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

      // Forward extensions to the custom panel
      const panelExtensions = entries
        .filter(([, ext]) => (ext.extraUrls ?? []).length > 0)
        .flatMap(([id, ext]) => {
          const title = ext.labels?.['org.opencontainers.image.title'] || id;

          return (ext.extraUrls ?? []).map(link => ({
            id,
            label: `${ title } — ${ link.label }`,
            url:   link.url,
          }));
        });
      sendPanelState({ extensions: panelExtensions });
    } catch (ex) {
      console.debug(`Failed to refresh extensions tray menu: ${ ex }`);
    }
  }
}
