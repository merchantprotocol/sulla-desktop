import * as darwin from './darwin';
import * as linux from './linux';
import * as win32 from './win32';

const backends: Record<string, any> = { darwin, linux, win32 };
const backend = backends[process.platform];
if (!backend) throw new Error(`Unsupported platform: ${ process.platform }`);

export const loopback = backend.loopback;
export const mirror = backend.mirror;
export const watcher = backend.watcher;
export const capture = backend.capture;
export const devices = backend.devices;
export const volume = backend.volume;
