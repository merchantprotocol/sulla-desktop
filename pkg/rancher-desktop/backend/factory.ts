import os from 'os';

import { Architecture, VMBackend } from './backend';
import MockBackend from './mock';
import SullaRuntimeBackend from './sullaRuntimeBackend';
import WSLKubernetesBackend from './kube/wsl';
import WSLBackend from './wsl';

import { WSLKubernetesBackendMock } from '@pkg/backend/mock_screenshots';

export default function factory(arch: Architecture): VMBackend {
  const platform = os.platform();

  if (process.env.RD_MOCK_BACKEND === '1') {
    return new MockBackend();
  }

  switch (platform) {
  case 'darwin':
    return new SullaRuntimeBackend(arch);
  case 'win32':
    return new WSLBackend((backend: WSLBackend) => {
      if (process.env.RD_MOCK_FOR_SCREENSHOTS) {
        return new WSLKubernetesBackendMock(backend);
      } else {
        return new WSLKubernetesBackend(backend);
      }
    });
  default:
    throw new Error(`OS "${ platform }" is not supported; Sulla Desktop runs on macOS and Windows.`);
  }
}
