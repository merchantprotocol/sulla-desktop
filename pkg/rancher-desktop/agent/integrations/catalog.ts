import type { Integration } from './types';
import { nativeIntegrations } from './native';
export type { Integration } from './types';

/** Always-available integrations (Slack, GitHub, ActivePieces, AI providers) */
export const integrations: Record<string, Integration> = {
  ...nativeIntegrations,
};
