// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface ParentNoticeInbox {
  enqueue(channel: string, threadId: string, notice: {
    jobId: string; taskIndex: number; results: []; notice: string; dedupeKey: string;
  }): boolean;
}
