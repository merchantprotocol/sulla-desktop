// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isChatModel, modelDiscoveryService } from '../../languagemodels/ModelDiscoveryService';
import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

/** Live model picker shared by OpenAI-compatible API providers. */
export class OpenAICompatibleModels extends SelectBoxProvider {
  constructor(
    readonly id: string,
    private readonly providerId: string,
  ) {
    super();
  }

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const models = await modelDiscoveryService.fetchModelsForProvider(
      this.providerId,
      context.formValues.api_key || '',
      { baseUrl: context.formValues.base_url, region: context.formValues.region },
    );

    return models.filter(isChatModel).map(model => ({
      value:       model.id,
      label:       model.name || model.id,
      description: model.description,
    }));
  }
}
