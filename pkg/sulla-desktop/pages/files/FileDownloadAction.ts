// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { reactive } from 'vue';

interface DownloadIpc {
  invoke(channel: 'files-ui:download-file', input: { fileId: string; name: string; versionId?: string }): Promise<boolean>;
}

/** One save dialog per action, including while a cited path is being resolved. */
export class FileDownloadAction {
  readonly state = reactive({ busy: false, error: '' });

  constructor(private readonly invoke: (name: string, versionId?: string) => Promise<boolean>) {}

  static forIpc(ipc: DownloadIpc, fileId: () => string | Promise<string>): FileDownloadAction {
    return new FileDownloadAction(async(name, versionId) => ipc.invoke('files-ui:download-file', {
      fileId: await fileId(), name, versionId,
    }));
  }

  async download(name: string, versionId?: string): Promise<void> {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.error = '';
    try {
      await this.invoke(name, versionId); // false means the user cancelled the native dialog.
    } catch {
      this.state.error = `Couldn't download ${ name }. Check your connection or that the file still exists.`;
    } finally {
      this.state.busy = false;
    }
  }
}
