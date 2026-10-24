import path from 'path';

import { app, dialog } from 'electron';

import { webRoot, createWindow, getWindow } from '.';

import { Help } from '@pkg/config/help';
import paths from '@pkg/utils/paths';
import { PREFERENCES_SECTION_IDS } from '@pkg/utils/preferencesModel';
import { CommandOrControl, Shortcuts } from '@pkg/utils/shortcuts';
import { getVersion } from '@pkg/utils/version';

let isDirty = false;
let isLoaded = false;
let pendingSection: string | undefined;

// On macOS the window draws its own title bar under the traffic lights, like the main window.
const macTitleBar = process.platform === 'darwin'
  ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } }
  : {};

/**
 * Open the Preferences window, or focus it if it's already open.
 * @param section A section id (`models`, `voice`, `account`…) to show.
 */
export function openPreferences(section?: string) {
  const existing = getWindow('preferences');

  // Menu items pass their click arguments through; only a string names a section.
  section = typeof section === 'string' ? section : undefined;
  pendingSection = section;
  if (existing && isLoaded && section) {
    existing.webContents.send('route', { name: section });
    pendingSection = undefined;
  }
  if (!existing) {
    isLoaded = false;
  }

  const window = createWindow('preferences', `${ webRoot }/index.html#preferences`, {
    title:           'Sulla Desktop - Preferences',
    ...macTitleBar,
    minWidth:        900,
    minHeight:       560,
    width:           1120,
    height:          760,
    autoHideMenuBar: true,
    resizable:       true,
    minimizable:     true,
    show:            false,
    icon:            path.join(paths.resources, 'icons', 'logo-square-512.png'),
    parent:          getWindow('main') ?? undefined,
    webPreferences:  {
      devTools:         !app.isPackaged,
      nodeIntegration:  true,
      contextIsolation: false,
    },
  });

  if (!Shortcuts.isRegistered(window)) {
    Shortcuts.register(
      window,
      [{
        key:      '?',
        meta:     true,
        platform: 'darwin',
      }, {
        key:      'F1',
        platform: ['win32', 'linux'],
      }],
      async() => {
        Help.preferences.openUrl(await getVersion());
      },
      'preferences help',
    );

    Shortcuts.register(
      window,
      { key: 'Escape' },
      () => {
        window.close();
      },
      'Close preferences dialog',
    );

    PREFERENCES_SECTION_IDS.slice(0, 9).forEach((name, index) => {
      Shortcuts.register(
        window,
        {
          ...CommandOrControl,
          key: index + 1,
        },
        () => window.webContents.send('route', { name }),
        `switch preferences section ${ name }`,
      );
    });

    Shortcuts.register(
      window,
      {
        ...CommandOrControl,
        key: ']',
      },
      () => window.webContents.send('route', { direction: 'forward' }),
      'switch preferences tabs by cycle [forward]',
    );

    Shortcuts.register(
      window,
      {
        ...CommandOrControl,
        key: '[',
      },
      () => window.webContents.send('route', { direction: 'back' }),
      'switch preferences tabs by cycle [back]',
    );
  }

  // Listeners are added once, when the window is created, so reopening it doesn't stack close prompts.
  if (!existing) {
    window.webContents.on('ipc-message', (_event, channel) => {
      if (channel === 'preferences/load') {
        isLoaded = true;
        window.show();
        if (pendingSection) {
          window.webContents.send('route', { name: pendingSection });
          pendingSection = undefined;
        }
      }
    });
    window.on('closed', () => {
      isLoaded = false;
      isDirty = false;
    });

    window.on('close', (event) => {
      if (!isDirty || (process.env.RD_TEST ?? '').includes('e2e')) {
        return;
      }

      const cancelPosition = 1;

      const result = dialog.showMessageBoxSync(
        window,
        {
          title:    'Sulla Desktop - Close Preferences',
          type:     'warning',
          message:  'Close without applying your changes?',
          detail:   'Some changes restart Docker and haven’t been applied yet. Closing discards them.',
          cancelId: cancelPosition,
          buttons:  [
            'Discard changes',
            'Cancel',
          ],
        });

      if (result === cancelPosition) {
        event.preventDefault();
      }
    });
  }

  app.dock?.show();
}

export function preferencesSetDirtyFlag(dirtyFlag: boolean) {
  isDirty = dirtyFlag;
}
