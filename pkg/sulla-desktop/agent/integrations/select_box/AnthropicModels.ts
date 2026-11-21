// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';
import { sharedModelCatalog } from '../../languagemodels/sharedModelCatalog';

export class AnthropicModels extends SelectBoxProvider {
  readonly id = 'anthropic_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    // A custom endpoint needs explicit private discovery, never public substitution.
    if (context.formValues.base_url?.trim()) return [];
    return (await sharedModelCatalog.listModels('anthropic')).map(model => ({ value: model.id, label: model.name }));
  }
}
