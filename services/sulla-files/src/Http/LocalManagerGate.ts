// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Config } from '../config.js';
import type { LocalFilesManager } from '../localManager.js';
import { HttpError } from './HttpError.js';

/** The desktop-only local manager behind the Files mount and native sources; 404 where it is unavailable. */
export class LocalManagerGate {
  constructor(private readonly config:Config, private readonly manager?:LocalFilesManager) {}

  readonly fuseExperiment = ():LocalFilesManager => {
    if (!this.config.fuseExperiment || !this.manager || this.config.mode !== 'desktop') throw new HttpError(404, 'experimental Files mount is unavailable');
    return this.manager;
  };

  readonly nativeSources = ():LocalFilesManager => {
    if (!this.manager || this.config.mode !== 'desktop') throw new HttpError(404, 'native Files sources are unavailable');
    return this.manager;
  };
}
