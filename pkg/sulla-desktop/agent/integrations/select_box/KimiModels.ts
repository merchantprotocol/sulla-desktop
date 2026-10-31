// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

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
    const apiKey = context.formValues.api_key;
    const baseUrl = context.formValues.region === 'international'
      ? 'https://api.moonshot.ai/v1'
      : 'https://api.moonshot.cn/v1';

    if (!apiKey) {
      return KIMI_FALLBACK;
    }

    try {
      const response = await fetch(`${ baseUrl }/models`, {
        headers: { Authorization: `Bearer ${ apiKey }` },
      });

      if (!response.ok) {
        console.warn(`[KimiModels] API call failed: ${ response.status } ${ response.statusText }`);
        return KIMI_FALLBACK;
      }

      const body = await response.json() as { data?: { id: string }[] };

      if (body.data && body.data.length > 0) {
        console.log(`[KimiModels] Got ${ body.data.length } models from Moonshot API`);
        return body.data
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(m => ({ value: m.id, label: m.id }));
      }

      console.warn('[KimiModels] API returned no data');
    } catch (err) {
      console.error('[KimiModels] API call failed:', err);
    }

    return KIMI_FALLBACK;
  }
}
