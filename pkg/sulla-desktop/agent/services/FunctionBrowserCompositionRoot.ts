// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { BrowserUrlPolicy } from './BrowserUrlPolicy';
import { DesktopFunctionBrowserAdapter } from './DesktopFunctionBrowserAdapter';
import { FunctionBrowserCapabilityService } from './FunctionBrowserCapabilityService';
import { getChromeApi } from '@pkg/main/chromeApi';
export class FunctionBrowserCompositionRoot {
  readonly urlPolicy = new BrowserUrlPolicy();
  readonly adapter = new DesktopFunctionBrowserAdapter(getChromeApi());
  readonly capabilities = new FunctionBrowserCapabilityService(this.adapter, Date.now, undefined, this.urlPolicy);
}
export const functionBrowserCompositionRoot = new FunctionBrowserCompositionRoot();
