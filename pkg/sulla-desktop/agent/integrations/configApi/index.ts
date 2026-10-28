// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export { ConfigApiClient, IntegrationApiError } from './ConfigApiClient';
export type { CallOptions, PaginatedResult } from './ConfigApiClient';
export { IntegrationConfigLoader, getIntegrationConfigLoader } from './IntegrationConfigLoader';
export type {
  EndpointConfig,
  IntegrationAuthConfig,
  IntegrationTransport,
  LoadedIntegration,
  PaginationConfig,
  QueryParamDef,
  PathParamDef,
  ResponseConfig,
} from './types';
