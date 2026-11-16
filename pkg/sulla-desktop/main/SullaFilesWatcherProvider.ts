// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaFilesWatcher } from './sullaFilesWatcher';

export class SullaFilesWatcherProvider {
  private instance?:SullaFilesWatcher;
  resolve():SullaFilesWatcher { return this.instance ??= new SullaFilesWatcher() }
}

export const sullaFilesWatcherProvider = new SullaFilesWatcherProvider();
export function getSullaFilesWatcher():SullaFilesWatcher { return sullaFilesWatcherProvider.resolve() }
