// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as darwin from './darwin';
import * as linux from './linux';

const backends: Record<string, any> = { darwin, linux };
const backend = backends[process.platform];
if (!backend) throw new Error(`Unsupported platform: ${ process.platform }`);

export const loopback = backend.loopback;
export const mirror = backend.mirror;
export const watcher = backend.watcher;
export const capture = backend.capture;
export const devices = backend.devices;
export const volume = backend.volume;
export const whisper = backend.whisper;
