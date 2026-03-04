// Lightweight manifest registration — plain data only, no tool worker imports.
// Each category manifests.ts holds schemaDefs inline and uses dynamic import()
// for lazy-loading workers. This keeps the webpack bundle small at startup.

import { toolRegistry } from './registry';

import { calendarToolManifests } from './calendar/manifests';
import { dockerToolManifests } from './docker/manifests';
import { fsToolManifests } from './fs/manifests';
import { githubToolManifests } from './github/manifests';
import { integrationsToolManifests } from './integrations/manifests';
import { kubectlToolManifests } from './kubectl/manifests';
import { limaToolManifests } from './lima/manifests';
import { metaToolManifests } from './meta/manifests';
import { n8nToolManifests } from './n8n/manifests';
import { pgToolManifests } from './pg/manifests';
import { playwrightToolManifests } from './playwright/manifests';
import { rdctlToolManifests } from './rdctl/manifests';
import { redisToolManifests } from './redis/manifests';
import { slackToolManifests } from './slack/manifests';
import { skillsToolManifests } from './skills/manifests';
import { projectsToolManifests } from './projects/manifests';
import { workspaceToolManifests } from './workspace/manifests';
import { extensionsToolManifests } from './extensions/manifests';
import { bridgeToolManifests } from './bridge/manifests';

toolRegistry.registerManifests([
  ...bridgeToolManifests,
  ...calendarToolManifests,
  ...dockerToolManifests,
  ...extensionsToolManifests,
  ...fsToolManifests,
  ...githubToolManifests,
  ...integrationsToolManifests,
  ...kubectlToolManifests,
  ...limaToolManifests,
  ...metaToolManifests,
  ...n8nToolManifests,
  ...pgToolManifests,
  ...playwrightToolManifests,
  ...rdctlToolManifests,
  ...redisToolManifests,
  ...skillsToolManifests,
  ...projectsToolManifests,
  ...slackToolManifests,
  ...workspaceToolManifests,
]);

