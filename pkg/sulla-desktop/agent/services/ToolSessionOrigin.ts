// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AsyncLocalStorage } from 'node:async_hooks';

/** Tool dispatch has no independent authority to start a Clerk-enabled graph. */
export class ToolSessionOrigin {
  private readonly nested = new AsyncLocalStorage<true>();
  get ordinaryOnly(): boolean { return this.nested.getStore() === true; }
  withinTool<T>(invoke: () => T): T { return this.nested.run(true, invoke); }
}

export const toolSessionOrigin = new ToolSessionOrigin();
