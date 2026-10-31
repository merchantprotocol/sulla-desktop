// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { GoogleService } from './GoogleService';
import { getIntegrationService } from '../services/IntegrationService';

let instance: GoogleService | undefined;

export async function getVertexAIService(): Promise<GoogleService> {
  if (instance) return instance;
  const values = Object.fromEntries((await getIntegrationService().getFormValues('vertex-ai')).map(value => [value.property, value.value]));
  if (!values.project_id || !values.region || !values.model) throw new Error('Vertex AI requires a project ID, region, and model');
  instance = new GoogleService({
    id: 'vertex-ai',
    model: values.model,
    baseUrl: `https://${ values.region }-aiplatform.googleapis.com/v1/projects/${ encodeURIComponent(values.project_id) }/locations/${ encodeURIComponent(values.region) }/publishers/google`,
    apiKey: values.api_key || '',
  });
  return instance;
}
