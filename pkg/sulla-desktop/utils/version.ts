// SPDX-License-Identifier: GPL-2.0-or-later
import Electron from 'electron';

import { spawnFile } from '@pkg/utils/childProcess';

type SpawnFile = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'inherit'] }) => Promise<{ stdout: string }>;

/** Reads the running app's version (packaged, dev git tag or mock) and maps it to a docs version. */
export class AppVersionService {
  private static sharedInstance: AppVersionService | undefined;

  static get shared(): AppVersionService {
    AppVersionService.sharedInstance ??= new AppVersionService();

    return AppVersionService.sharedInstance;
  }

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly runFile: SpawnFile = (command, args, options) => spawnFile(command, args, options),
    private readonly isPackaged: () => boolean = () => Electron.app.isPackaged === true,
  ) {}

  getProductionVersion(): string {
    try {
      return Electron.app.getVersion();
    } catch (err) {
      console.log(`Can't get app version: ${ err }`);

      return '?';
    }
  }

  async getDevVersion(): Promise<string> {
    try {
      const { stdout } = await this.runFile('git', ['describe', '--tags'], { stdio: ['ignore', 'pipe', 'inherit'] });

      return stdout.trim();
    } catch (err) {
      console.log(`Can't get app version: ${ err }`);

      return '?';
    }
  }

  async getVersion(): Promise<string> {
    if (this.env.SULLA_MOCK_VERSION) {
      return this.env.SULLA_MOCK_VERSION;
    }

    // Packaged builds read app.getVersion(); git describe only exists in a dev checkout.
    if (this.isPackaged() || this.env.SULLA_MOCK_FOR_SCREENSHOTS) {
      return this.getProductionVersion();
    }

    return await this.getDevVersion();
  }

  parseDocsVersion(version: string): string {
    // Match '1.9.0-tech-preview' (returns '1.9-tech-preview'), but not '1.9.0-123-g1234567' (returns 'next')
    const releasePattern = /^v?(\d+\.\d+)\.\d+(-[a-z].*)?$/;
    const matches = releasePattern.exec(version);

    if (matches) {
      if (matches[2]) {
        return matches[1].concat(matches[2]);
      }

      return matches[1];
    }

    return 'next';
  }
}

/** @deprecated use AppVersionService.shared.getProductionVersion */
export function getProductionVersion() {
  return AppVersionService.shared.getProductionVersion();
}

/** @deprecated use AppVersionService.shared.getVersion */
export function getVersion() {
  return AppVersionService.shared.getVersion();
}

/** @deprecated use AppVersionService.shared.parseDocsVersion */
export function parseDocsVersion(version: string) {
  return AppVersionService.shared.parseDocsVersion(version);
}
