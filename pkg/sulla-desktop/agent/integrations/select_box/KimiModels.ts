// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';
import { modelDiscoveryService } from '../../languagemodels/ModelDiscoveryService';

// Offline fallback only — used when the live Moonshot /models call fails or the
// user hasn't supplied an api_key yet. The authoritative list is fetched live.
const KIMI_FALLBACK: SelectOption[] = [
  { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K', description: '128K context window' },
  { value: 'moonshot-v1-32k', label: 'Moonshot v1 32K', description: '32K context window' },
  { value: 'moonshot-v1-8k', label: 'Moonshot v1 8K', description: '8K context window' },
];

export class KimiModels extends SelectBoxProvider {
  readonly id = 'kimi_models';

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    const baseUrl = context.formValues.region === 'international'
      ? 'https://api.moonshot.ai/v1'
      : 'https://api.moonshot.cn/v1';
    const models = await modelDiscoveryService.fetchModelsForProvider('kimi', context.formValues.api_key || '', {
      accountId: context.accountId,
      baseUrl,
      region: context.formValues.region,
      liveOnly: context.liveOnly,
    });
    if (models.length) return models.sort((a, b) => a.id.localeCompare(b.id)).map(model => ({ value: model.id, label: model.name || model.id }));
    return context.liveOnly ? [] : KIMI_FALLBACK;
  }
}
