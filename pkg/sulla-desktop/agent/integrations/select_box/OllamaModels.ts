// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CustomModels } from './CustomModels';
import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

/**
 * Lists the models on the user's own Ollama server via its
 * OpenAI-compatible /v1/models endpoint (same shape as a custom provider).
 */
export class OllamaModels extends SelectBoxProvider {
  readonly id = 'ollama_models';

  private readonly compatible = new CustomModels();

  async getOptions(context: SelectBoxContext): Promise<SelectOption[]> {
    return this.compatible.getOptions(context);
  }
}
