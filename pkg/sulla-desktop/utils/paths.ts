// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Single source of truth for filesystem paths used by Sulla Desktop.
 *
 * SSOT RULE: All host filesystem paths must originate here. Do not call
 * `os.homedir()` outside this file (and `agent/utils/sullaPaths.ts`, which
 * is the env-override layer that delegates to this module). Exceptions:
 *   - Expanding a `~` typed by the user (read_file, write_file, meta_search).
 *   - External-tool conventions owned by other vendors (`~/.docker`, `~/.kube`).
 *
 * Paths are derived in-process so every Electron process uses the same
 * platform conventions without an external management binary.
 */
import os from 'os';
import path from 'path';

import { requestedInstance } from '@pkg/utils/instance';


export interface Paths {
  /** appHome: the location of the main appdata directory. */
  appHome:                    string;
  /**
   * altAppHome is a secondary directory for application data (`~/.sulla-desktop-data`).
   * It is not `~/.sulla-desktop`: that is the installer's git checkout
   * (`sullaDesktopCodebase`), and factory reset deletes altAppHome.
   */
  altAppHome:                 string;
  /** Directory which holds configuration. */
  config:                     string;
  /** Directory which holds logs. */
  logs:                       string;
  /** Directory which holds caches that may be removed. */
  cache:                      string;
  /** Directory that holds resource files in the Sulla Desktop installation. */
  resources:                  string;
  /** Full path to the `sulla-runtime` host binary that boots the VM and runs guest commands (macOS). */
  sullaRuntime:               string;
  /** Sulla user home — `~/sulla`. Houses workflows, functions, captures, logs. */
  sullaHome:                  string;
  /** Sulla config dir — `~/.sulla`. Houses MCP configs, vault key, device id. */
  sullaConfig:                string;
  /** Sulla Desktop codebase mirror dir — `~/.sulla-desktop`. */
  sullaDesktopCodebase:       string;
  /** Directory holding provided binary resources */
  integration:                string;
  /** Deployment Profile System-wide startup settings path. */
  deploymentProfileSystem:    string;
  /** Secondary Deployment Profile System-wide startup settings path. */
  altDeploymentProfileSystem: string;
  /** Deployment Profile User startup settings path. */
  deploymentProfileUser:      string;
  /** Directory that will hold extension data. */
  readonly extensionRoot:     string;
  /** Directory that holds snapshots. */
  snapshots:                  string;
  /** Directory that holds user-managed containerd-shims. */
  containerdShims:            string;
}

export class UnixPaths implements Paths {
  appHome = '';
  altAppHome = '';
  config = '';
  logs = '';
  cache = '';
  resources = '';
  sullaRuntime = '';
  sullaHome = '';
  sullaConfig = '';
  sullaDesktopCodebase = '';
  integration = '';
  deploymentProfileSystem = '';
  altDeploymentProfileSystem = '';
  deploymentProfileUser = '';
  extensionRoot = '';
  snapshots = '';
  containerdShims = '';

  constructor(pathsData: Record<string, unknown>) {
    Object.assign(this, pathsData);
  }
}

/** Build paths using the application's established platform data locations. */
function getDefaultPaths(): Partial<Paths> {
  const home = os.homedir();
  const instanceSuffix = requestedInstance() ? `-${ requestedInstance() }` : '';

  switch (process.platform) {
  case 'darwin': {
    const appHome = path.join(home, 'Library', 'Application Support', `sulla-desktop${ instanceSuffix }`);
    // In a packaged app, process.resourcesPath points to Contents/Resources;
    // extraResources are nested under a 'resources' subdirectory there.
    // In dev, fall back to the project's resources directory.
    const resources = process.resourcesPath
      ? path.join(process.resourcesPath, 'resources')
      : path.join(process.cwd(), 'resources');

    return {
      appHome,
      altAppHome:                 path.join(home, `.sulla-desktop-data${ instanceSuffix }`),
      config:                     path.join(home, 'Library', 'Preferences', `sulla-desktop${ instanceSuffix }`),
      logs:                       path.join(home, 'Library', 'Logs', `sulla-desktop${ instanceSuffix }`),
      cache:                      path.join(home, 'Library', 'Caches', `sulla-desktop${ instanceSuffix }`),
      resources,
      integration:                path.join(home, `.sulla-desktop-data${ instanceSuffix }`, 'bin'),
      deploymentProfileSystem:    '/Library/Managed Preferences',
      altDeploymentProfileSystem: '/Library/Preferences',
      deploymentProfileUser:      path.join(home, 'Library', 'Preferences'),
      extensionRoot:              path.join(home, 'Library', 'Application Support', `sulla-desktop${ instanceSuffix }`, 'extensions'),
      snapshots:                  path.join(appHome, 'snapshots'),
      containerdShims:            path.join(appHome, 'containerd-shims'),
    };
  }
  case 'linux': {
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    const appHome = path.join(dataHome, `sulla-desktop${ instanceSuffix }`);
    const resources = process.resourcesPath
      ? path.join(process.resourcesPath, 'resources')
      : path.join(process.cwd(), 'resources');

    return {
      appHome,
      altAppHome:                 path.join(home, `.sulla-desktop-data${ instanceSuffix }`),
      config:                     path.join(configHome, `sulla-desktop${ instanceSuffix }`),
      logs:                       path.join(dataHome, `sulla-desktop${ instanceSuffix }`, 'logs'),
      cache:                      path.join(cacheHome, `sulla-desktop${ instanceSuffix }`),
      resources,
      integration:                path.join(home, `.sulla-desktop-data${ instanceSuffix }`, 'bin'),
      deploymentProfileSystem:    '/etc/sulla-desktop',
      altDeploymentProfileSystem: '/usr/etc/sulla-desktop',
      deploymentProfileUser:      configHome,
      extensionRoot:              path.join(dataHome, `sulla-desktop${ instanceSuffix }`, 'extensions'),
      snapshots:                  path.join(appHome, 'snapshots'),
      containerdShims:            path.join(appHome, 'containerd-shims'),
    };
  }
  default:
    return {};
  }
}

/**
 * Augment the platform paths with Sulla-specific and derived locations.
 */
function augmentPaths(pathsData: Partial<Paths>): Partial<Paths> {
  const home = os.homedir();
  const instanceSuffix = requestedInstance() ? `-${ requestedInstance() }` : '';

  if (!pathsData.sullaHome) {
    pathsData.sullaHome = path.join(home, `sulla${ instanceSuffix }`);
  }
  if (!pathsData.sullaConfig) {
    pathsData.sullaConfig = path.join(home, `.sulla${ instanceSuffix }`);
  }
  if (!pathsData.sullaDesktopCodebase) {
    pathsData.sullaDesktopCodebase = path.join(home, `.sulla-desktop${ instanceSuffix }`);
  }
  if (!pathsData.sullaRuntime && pathsData.resources) {
    pathsData.sullaRuntime = process.env.SULLA_RUNTIME_BIN ||
      path.join(pathsData.resources, process.platform === 'darwin' ? 'darwin' : 'linux', 'sulla-runtime', 'sulla-runtime');
  }

  return pathsData;
}

function getPaths(): Paths {
  let pathsData = getDefaultPaths();

  if (!pathsData || Object.keys(pathsData).length === 0) {
    throw new Error(`Platform "${ process.platform }" is not supported.`);
  }

  pathsData = augmentPaths(pathsData);

  switch (process.platform) {
  case 'darwin':
    return new UnixPaths(pathsData);
  case 'linux':
    return new UnixPaths(pathsData);
  default:
    throw new Error(`Platform "${ process.platform }" is not supported.`);
  }
}

export default getPaths();
