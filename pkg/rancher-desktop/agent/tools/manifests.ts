// Lightweight manifest registration — plain data only, no tool worker imports.
// Each category manifests.ts holds schemaDefs inline and uses dynamic import()
// for lazy-loading workers. This keeps the webpack bundle small at startup.

import { agentToolManifests } from './agents/manifests';
import { applescriptToolManifests } from './applescript/manifests';
import { bridgeToolManifests } from './bridge/manifests';
import { browserToolManifests } from './browser/manifests';
import { calendarToolManifests } from './calendar/manifests';
import { captureToolManifests } from './capture/manifests';
import { dockerToolManifests } from './docker/manifests';
import { extensionsToolManifests } from './extensions/manifests';
import { functionToolManifests } from './function/manifests';
import { githubToolManifests } from './github/manifests';

import { integrationsToolManifests } from './integrations/manifests';
import { kubectlToolManifests } from './kubectl/manifests';
import { limaToolManifests } from './lima/manifests';
import { marketplaceToolManifests } from './marketplace/manifests';
import { metaToolManifests } from './meta/manifests';
import { n8nToolManifests } from './n8n/manifests';
import { notifyToolManifests } from './notify/manifests';
import { pgToolManifests } from './pg/manifests';
import { rdctlToolManifests } from './rdctl/manifests';
import { redisToolManifests } from './redis/manifests';
import { toolRegistry } from './registry';
import { secretaryToolManifests } from './secretary/manifests';
import { slackToolManifests } from './slack/manifests';
import { uiToolManifests } from './ui/manifests';
import { workflowToolManifests } from './workflow/manifests';

toolRegistry.registerManifests([
  ...agentToolManifests,
  ...applescriptToolManifests,
  ...bridgeToolManifests,
  ...browserToolManifests,
  ...calendarToolManifests,
  ...captureToolManifests,
  ...dockerToolManifests,
  ...extensionsToolManifests,
  ...functionToolManifests,
  ...githubToolManifests,
  ...integrationsToolManifests,
  ...kubectlToolManifests,
  ...limaToolManifests,
  ...marketplaceToolManifests,
  ...metaToolManifests,
  ...n8nToolManifests,
  ...notifyToolManifests,
  ...pgToolManifests,
  ...rdctlToolManifests,
  ...redisToolManifests,
  ...secretaryToolManifests,
  ...slackToolManifests,
  ...uiToolManifests,
  ...workflowToolManifests,
]);
