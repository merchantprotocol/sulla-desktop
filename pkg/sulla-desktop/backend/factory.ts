import os from 'os';

import { Architecture, VMBackend } from './backend';
import MockBackend from './mock';
import SullaRuntimeBackend from './sullaRuntimeBackend';

export default function factory(arch: Architecture): VMBackend {
  const platform = os.platform();

  if (process.env.RD_MOCK_BACKEND === '1') {
    return new MockBackend();
  }

  if (platform !== 'darwin') {
    throw new Error(`OS "${ platform }" is not supported; Sulla Desktop runs on macOS only.`);
  }

  return new SullaRuntimeBackend(arch);
}
