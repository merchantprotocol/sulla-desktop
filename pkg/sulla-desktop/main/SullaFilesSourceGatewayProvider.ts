// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaFilesSourceGateway } from './sullaFilesSourceGateway';

export class SullaFilesSourceGatewayProvider {
  private sourceGateway?:SullaFilesSourceGateway;

  start():SullaFilesSourceGateway {
    if (this.sourceGateway) return this.sourceGateway;
    return this.sourceGateway = new SullaFilesSourceGateway();
  }

  resolve():SullaFilesSourceGateway {
    if (!this.sourceGateway) throw new Error('Experimental native Files source gateway is not running');
    return this.sourceGateway;
  }

  async stop():Promise<void> {
    const gateway = this.sourceGateway;
    this.sourceGateway = undefined;
    await gateway?.stop();
  }

  async lock():Promise<void> { await this.sourceGateway?.lock(); }
  unlock():void { this.sourceGateway?.unlock(); }
}

export const sullaFilesSourceGatewayProvider = new SullaFilesSourceGatewayProvider();
export function startSullaFilesSourceGateway():SullaFilesSourceGateway { return sullaFilesSourceGatewayProvider.start() }
export function getSullaFilesSourceGateway():SullaFilesSourceGateway { return sullaFilesSourceGatewayProvider.resolve() }
export async function stopSullaFilesSourceGateway():Promise<void> { await sullaFilesSourceGatewayProvider.stop() }
export async function lockSullaFilesSourceGateway():Promise<void> { await sullaFilesSourceGatewayProvider.lock() }
export function unlockSullaFilesSourceGateway():void { sullaFilesSourceGatewayProvider.unlock() }
