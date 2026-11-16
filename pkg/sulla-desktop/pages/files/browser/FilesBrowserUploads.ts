// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, ref } from 'vue';

import type { FilesUploadLogItem, FilesUploadProgress } from './FilesBrowserTypes';

/** The upload progress tray: the file being sent and the ones finished in this batch. */
export class FilesBrowserUploads {
  static readonly DISMISS_MS = 2200;

  readonly uploadProgress = ref<FilesUploadProgress | null>(null);
  readonly uploadLog = ref<FilesUploadLogItem[]>([]);
  /** In-progress upload first, then the ones already finished in this batch (the stream only reports the current file). */
  readonly uploadItems = computed(() => [...this.uploadLog.value.filter(item => !item.done), ...this.uploadLog.value.filter(item => item.done).reverse()]);
  private dismissTimer:ReturnType<typeof setTimeout> | undefined;

  /** Data source upload progress listener. */
  readonly onUploadProgress = (progress:FilesUploadProgress):void => { if (this.dismissTimer) clearTimeout(this.dismissTimer); this.trackUpload(progress); this.uploadProgress.value = progress; if (progress.done) this.dismissTimer = setTimeout(() => { this.uploadProgress.value = null; this.uploadLog.value = [] }, FilesBrowserUploads.DISMISS_MS) };

  trackUpload(progress:{ current: number; name: string; percent: number; done: boolean }):void { const log = progress.current <= 1 && !this.uploadLog.value.some(item => item.name === progress.name) ? [] : this.uploadLog.value.map(item => item.name === progress.name ? item : { ...item, done: true, percent: 100 }); const rest = log.filter(item => item.name !== progress.name); this.uploadLog.value = [...rest, { name: progress.name, percent: progress.percent, done: progress.done || progress.percent >= 100 }] }

  readonly hideUploadProgress = ():void => { this.uploadProgress.value = null; this.uploadLog.value = [] };

  stop():void { if (this.dismissTimer) clearTimeout(this.dismissTimer) }
}
