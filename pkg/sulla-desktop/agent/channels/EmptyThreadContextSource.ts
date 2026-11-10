// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ThreadContextSource } from './types';
export class EmptyThreadContextSource implements ThreadContextSource {
  async fetchRecent(_workspaceId: string, _conversationId: string, _threadKey: string, _limit: number): Promise<string[]> { return []; }
}
