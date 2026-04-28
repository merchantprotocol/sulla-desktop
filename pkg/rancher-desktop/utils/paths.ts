/**
 * This module describes the various paths we use to store state & data.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import electron from 'electron';

export interface Paths {
  /** appHome: the location of the main appdata directory. */
  appHome:                    string;
  /** altAppHome is a secondary directory for application data. */
  altAppHome:                 string;
  /** Directory which holds configuration. */
  config:                     string;
  /** Directory which holds logs. */
  logs:                       string;
  /** Directory which holds caches that may be removed. */
  cache:                      string;
  /** Directory that holds resource files in the RD installation. */
  resources:                  string;
  /** Directory holding Lima state (Unix-specific). */
  lima:                       string;
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
  /** Directory holding the WSL distribution (Windows-specific). */
  wslDistro:                  string;
  /** Directory holding the WSL data distribution (Windows-specific). */
  wslDistroData:              string;
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
  lima = '';
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

  get wslDistro(): string {
    throw new Error('wslDistro not available for Unix');
  }

  get wslDistroData(): string {
    throw new Error('wslDistroData not available for Unix');
  }
}

export class WindowsPaths implements Paths {
  appHome = '';
  altAppHome = '';
  config = '';
  logs = '';
  cache = '';
  resources = '';
  extensionRoot = '';
  wslDistro = '';
  wslDistroData = '';
  snapshots = '';
  containerdShims = '';

  constructor(pathsData: Record<string, unknown>) {
    Object.assign(this, pathsData);
  }

  get lima(): string {
    throw new Error('lima not available for Windows');
  }

  get integration(): string {
    throw new Error('Internal error: integration path not available for Windows');
  }

  get deploymentProfileSystem(): string {
    throw new Error('Internal error: Windows profiles will be read from Registry');
  }

  get altDeploymentProfileSystem(): string {
    throw new Error('Internal error: Windows profiles will be read from Registry');
  }

  get deploymentProfileUser(): string {
    throw new Error('Internal error: Windows profiles will be read from Registry');
  }
}

// Gets the path to rdctl. Returns null if rdctl cannot be found.
export function getRdctlPath(): string | null {
  let basePath: string;

  // If we are running as a script (i.e. yarn postinstall), electron.app is undefined.
  // In renderer processes, electron.app is not available, but process.resourcesPath
  // is still set when packaged — check it directly.
  if (electron.app?.isPackaged || (process.type === 'renderer' && process.resourcesPath)) {
    basePath = process.resourcesPath;
  } else if (process.env.SULLA_PROJECT_DIR) {
    basePath = process.env.SULLA_PROJECT_DIR;
  } else {
    try {
      basePath = process.cwd();
    } catch {
      return null;
    }
  }
  const osSpecificName = os.platform().startsWith('win') ? `rdctl.exe` : 'rdctl';
  const rdctlPath = path.join(basePath, 'resources', os.platform(), 'bin', osSpecificName);

  if (!fs.existsSync(rdctlPath)) {
    return null;
  }

  return rdctlPath;
}

/**
 * Build default paths without rdctl. Used as a fallback when rdctl is
 * unavailable (e.g. in renderer processes).
 */
function getDefaultPaths(): Partial<Paths> {
  const home = os.homedir();

  switch (process.platform) {
  case 'darwin': {
    const appHome = path.join(home, 'Library', 'Application Support', 'rancher-desktop');
    // In a packaged app, process.resourcesPath points to Contents/Resources;
    // extraResources are nested under a 'resources' subdirectory there.
    // In dev, fall back to the project's resources directory.
    const resources = process.resourcesPath
      ? path.join(process.resourcesPath, 'resources')
      : path.join(process.cwd(), 'resources');

    // Lima's ssh socket path appends /0/ssh.sock. + up to 16 chars (28 total).
    // UNIX_PATH_MAX=104, so the lima home must be ≤76 chars. Fall back to ~/.rd/lima
    // for users whose Library path is too long (e.g. long usernames).
    const standardLima = path.join(appHome, 'lima');
    const lima = standardLima.length <= 76 ? standardLima : path.join(home, '.rd', 'lima');

    return {
      appHome,
      altAppHome:                 path.join(home, '.rd'),
      config:                     path.join(home, 'Library', 'Preferences', 'rancher-desktop'),
      logs:                       path.join(home, 'Library', 'Logs', 'rancher-desktop'),
      cache:                      path.join(home, 'Library', 'Caches', 'rancher-desktop'),
      resources,
      lima,
      integration:                path.join(home, '.rd', 'bin'),
      deploymentProfileSystem:    '/Library/Managed Preferences',
      altDeploymentProfileSystem: '/Library/Preferences',
      deploymentProfileUser:      path.join(home, 'Library', 'Preferences'),
      extensionRoot:              path.join(appHome, 'extensions'),
      snapshots:                  path.join(appHome, 'snapshots'),
      containerdShims:            path.join(appHome, 'containerd-shims'),
    };
  }
  case 'linux': {
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    const appHome = path.join(dataHome, 'rancher-desktop');
    const resources = process.resourcesPath
      ? path.join(process.resourcesPath, 'resources')
      : path.join(process.cwd(), 'resources');

    return {
      appHome,
      altAppHome:                 path.join(home, '.rd'),
      config:                     path.join(configHome, 'rancher-desktop'),
      logs:                       path.join(dataHome, 'rancher-desktop', 'logs'),
      cache:                      path.join(cacheHome, 'rancher-desktop'),
      resources,
      lima:                       path.join(dataHome, 'rancher-desktop', 'lima'),
      integration:                path.join(home, '.rd', 'bin'),
      deploymentProfileSystem:    '',
      altDeploymentProfileSystem: '',
      deploymentProfileUser:      '',
      extensionRoot:              path.join(appHome, 'extensions'),
      snapshots:                  path.join(appHome, 'snapshots'),
      containerdShims:            path.join(appHome, 'containerd-shims'),
    };
  }
  default:
    return {};
  }
}

function getPaths(): Paths {
  const rdctlPath = getRdctlPath();
  let pathsData: Partial<Paths> | undefined;

  if (rdctlPath) {
    const result = spawnSync(rdctlPath, ['paths'], { encoding: 'utf8' });

    if (result.status === 0 && result.stdout.length > 0) {
      pathsData = JSON.parse(result.stdout);
    }
  }

  // Fallback to default paths when rdctl is unavailable (e.g. renderer processes)
  if (!pathsData) {
    pathsData = getDefaultPaths();
  }

  if (!pathsData || Object.keys(pathsData).length === 0) {
    throw new Error(`Platform "${ process.platform }" is not supported.`);
  }

  switch (process.platform) {
  case 'darwin':
    return new UnixPaths(pathsData);
  case 'linux':
    return new UnixPaths(pathsData);
  case 'win32':
    return new WindowsPaths(pathsData);
  default:
    throw new Error(`Platform "${ process.platform }" is not supported.`);
  }
}

export default getPaths();
