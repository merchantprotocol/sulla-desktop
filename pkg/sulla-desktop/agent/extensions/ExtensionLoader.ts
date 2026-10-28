// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FunctionDefinitionModel } from '../database/models/MarketplaceArtifactModel';
import { runFunctionStructured } from '../tools/function/function_run';
import { EXTENSION_HOOKS, extensionHooks, ExtensionHookName } from './HookRegistry';
import { extensionUI, ExtensionUISlot } from './ExtensionUIRegistry';

/** Rebuild executable hook registrations from installed, enabled function artifacts. */
export async function reloadExtensionHooks(): Promise<void> {
  extensionHooks.clear();
  extensionUI.clear();
  for (const fn of await FunctionDefinitionModel.list()) {
    const ui = fn.manifest?.ui;
    if (Array.isArray(ui)) for (const item of ui) {
      if (item && ['sidebar_entry', 'settings_tab', 'chat_card'].includes(item.slot) && item.id && item.label && item.component) {
        extensionUI.register({ extensionId: `function:${ fn.slug }`, slot: item.slot as ExtensionUISlot, id: item.id, label: item.label, icon: item.icon, component: item.component, order: item.order });
      }
    }
    const declarations = fn.manifest?.hooks;
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations) {
      const hook = (typeof declaration === 'string' ? declaration : declaration?.name) as ExtensionHookName;
      if (!(hook in EXTENSION_HOOKS)) continue;
      extensionHooks.register({
        extensionId: `function:${ fn.slug }`, hook,
        priority: typeof declaration === 'object' ? declaration.priority : undefined,
        timeoutMs: typeof declaration === 'object' ? declaration.timeoutMs : undefined,
        handler: async(payload) => {
          const result = await runFunctionStructured({ slug: fn.slug, inputs: { hook, payload: payload as unknown } });
          if (!result.successBoolean) throw new Error(result.responseString);
          // Function outputs are always an object. Only an explicit `value` replaces the core value;
          // anything else is a deny decision or a pass-through, so `{}` can never wipe a payload.
          const outputs = (result.outputs?.result ?? result.outputs) as Record<string, unknown> | undefined;
          if (!outputs || typeof outputs !== 'object') return undefined;
          if (outputs.denied === true || outputs.allow === false) return { denied: true, reason: outputs.reason };
          return 'value' in outputs ? { value: outputs.value } : undefined;
        },
      });
    }
  }
}
