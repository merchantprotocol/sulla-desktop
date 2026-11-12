// SPDX-License-Identifier: GPL-2.0-or-later
import os from 'os';

import { Architecture, VMBackend } from './backend';
import { LinuxDockerBackend } from './linux/linuxVmBackend';
import MockBackend from './mock';
import SullaRuntimeBackend from './sullaRuntimeBackend';

import paths from '@pkg/utils/paths';

export default function factory(arch: Architecture, platform: NodeJS.Platform = os.platform()): VMBackend {
  if (process.env.SULLA_MOCK_BACKEND === '1') {
    return new MockBackend();
  }

  if (platform === 'linux') {
    return LinuxDockerBackend.create({ appDataDirectory: paths.appHome });
  }

  if (platform !== 'darwin') {
    throw new Error(`OS "${ platform }" is not supported; Sulla Desktop runs on macOS and Linux (Windows WSL2 is staged separately).`);
  }

  return new SullaRuntimeBackend(arch);
}
