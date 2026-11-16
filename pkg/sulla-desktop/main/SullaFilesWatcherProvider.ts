// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaFilesWatcher } from './sullaFilesWatcher';
import { NativeSourceRevalidator } from './NativeSourceRevalidator';
import { VaultFilesStartup } from './VaultFilesStartup';

export class SullaFilesWatcherProvider {
  private instance?:SullaFilesWatcher;
  constructor(
    private readonly startupFactory:() => VaultFilesStartup = () => new VaultFilesStartup(),
    private readonly revalidatorFactory:(post:ConstructorParameters<typeof NativeSourceRevalidator>[0]['post']) => NativeSourceRevalidator = post => new NativeSourceRevalidator({ post }),
  ) {}

  resolve():SullaFilesWatcher {
    return this.instance ??= new SullaFilesWatcher(this.startupFactory(), this.revalidatorFactory);
  }
}

export const sullaFilesWatcherProvider = new SullaFilesWatcherProvider();
export function getSullaFilesWatcher():SullaFilesWatcher { return sullaFilesWatcherProvider.resolve() }
