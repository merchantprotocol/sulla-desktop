import fs from 'fs';
import path from 'path';

import { sullaRuntimeDirectory } from './artifacts';

export interface DataDiskResult {
  path:   string;
  /** Already there, or left for the runtime to create and format blank. */
  source: 'existing' | 'blank';
}

/** The runtime's data disk; the runtime creates and formats it on first boot. */
export async function ensureSullaRuntimeDataDisk(): Promise<DataDiskResult> {
  const directory = sullaRuntimeDirectory();
  const target = path.join(directory, 'data.img');

  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await fs.promises.access(target).then(() => true, () => false);

  return { path: target, source: existing ? 'existing' : 'blank' };
}
