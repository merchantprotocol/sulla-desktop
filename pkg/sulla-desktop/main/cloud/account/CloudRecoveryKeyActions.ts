// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalVaultApprovalClient } from '@pkg/vault-broker';

import type { recoveryKeyStorageStatus } from '../../recoveryKeychain';
import type { AuthStatus } from '../session/CloudAuthStatusService';

type RecoveryKeyStorage = ReturnType<typeof recoveryKeyStorageStatus>;

/** A hidden, sandboxed page the recovery key is rendered into for printing or PDF export. */
export interface RecoveryKeyPage {
  loadURL(url: string): Promise<void>;
  print(): Promise<void>;
  printToPDF(): Promise<Buffer>;
  destroy(): void;
}

export interface CloudRecoveryKeyPorts {
  status(): Promise<AuthStatus>;
  approvalClient(): LocalVaultApprovalClient | null;
  recoveryKeyStorageStatus(): RecoveryKeyStorage;
  readRecoveryKey(): Promise<string | null | undefined>;
  saveRecoveryKey(userId: string, recoveryKey: string): Promise<RecoveryKeyStorage>;
  copyToClipboard(text: string): void;
  /** The focused window the dialog and hidden page belong to, if any. */
  focusedWindow(): unknown;
  openHiddenPage(owner: unknown): RecoveryKeyPage;
  /** Shows the save dialog; undefined when the owner cancelled. */
  chooseSavePath(owner: unknown, options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  writePrivateFile(filePath: string, data: Buffer): Promise<void>;
  now(): Date;
}

/** The Settings → Recovery key actions: status, rotate, copy, print and save as PDF. */
export class CloudRecoveryKeyActions {
  private static readonly KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;

  constructor(private readonly ports: CloudRecoveryKeyPorts) {}

  async status(): Promise<RecoveryKeyStorage & { checkedAt: string }> {
    const status = this.ports.recoveryKeyStorageStatus();
    if (status.location !== 'unavailable' && !await this.ports.readRecoveryKey()) {
      return { location: 'unavailable', label: 'Recovery key is not saved', checkedAt: this.ports.now().toISOString() } as RecoveryKeyStorage & { checkedAt: string };
    }
    return { ...status, checkedAt: this.ports.now().toISOString() };
  }

  async rotate() {
    const status = await this.ports.status();
    if (!status.signedIn || !status.userId) throw new Error('Sign in to Sulla Cloud before making a recovery key.');
    const client = this.ports.approvalClient();
    if (!client) throw new Error('Desktop vault recovery service is unavailable.');
    const result = await client.rotateRecoveryKey();
    const storage = await this.ports.saveRecoveryKey(status.userId, result.recoveryKey);
    return { ...result, storage, madeAt: this.ports.now().toISOString() };
  }

  async copy(recoveryKey: string): Promise<void> {
    CloudRecoveryKeyActions.requireValid(recoveryKey);
    this.ports.copyToClipboard(recoveryKey);
  }

  async print(recoveryKey: string): Promise<void> {
    CloudRecoveryKeyActions.requireValid(recoveryKey);
    const print = this.ports.openHiddenPage(this.ports.focusedWindow());
    try {
      await print.loadURL(`data:text/html,${ encodeURIComponent(`<title>Sulla recovery key</title><h1>Sulla recovery key</h1><p>Keep this somewhere safe.</p><pre>${ recoveryKey }</pre>`) }`);
      await print.print();
    } finally { print.destroy() }
  }

  async save(recoveryKey: string): Promise<{ saved: boolean }> {
    CloudRecoveryKeyActions.requireValid(recoveryKey);
    const owner = this.ports.focusedWindow();
    const filePath = await this.ports.chooseSavePath(owner, { defaultPath: 'Sulla recovery key.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!filePath) return { saved: false };
    const page = this.ports.openHiddenPage(owner);
    try {
      await page.loadURL(`data:text/html,${ encodeURIComponent(`<title>Sulla recovery key</title><style>body{font:18px system-ui;padding:48px}pre{font:22px monospace}</style><h1>Sulla recovery key</h1><p>Keep this somewhere safe.</p><pre>${ recoveryKey }</pre>`) }`);
      const pdf = await page.printToPDF();
      await this.ports.writePrivateFile(filePath, pdf);
    } finally { page.destroy() }
    return { saved: true };
  }

  private static requireValid(recoveryKey: string): void {
    if (!CloudRecoveryKeyActions.KEY_FORMAT.test(recoveryKey)) throw new Error('Recovery key is invalid.');
  }
}
