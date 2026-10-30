// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Every tool manifest in one list, without registering anything. The registry,
// the tool-placements generator and the placement tests all read this list.

import { agentToolManifests } from './agents/manifests';
import { applescriptToolManifests } from './applescript/manifests';
import { bookmarkToolManifests } from './bookmarks/manifests';
import { bridgeToolManifests } from './bridge/manifests';
import { browserToolManifests } from './browser/manifests';
import { calendarToolManifests } from './calendar/manifests';
import { captureToolManifests } from './capture/manifests';
import { chatToolManifests } from './chat/manifests';
import { dockerToolManifests } from './docker/manifests';
import { episodicToolManifests } from './episodic/manifests';
import { extensionsToolManifests } from './extensions/manifests';
import { filesToolManifests } from './files/manifests';
import { functionToolManifests } from './function/manifests';
import { gdriveToolManifests } from './gdrive/manifests';
import { githubToolManifests } from './github/manifests';
import { integrationsToolManifests } from './integrations/manifests';
import { ledgerToolManifests } from './ledger/manifests';
import { marketplaceToolManifests } from './marketplace/manifests';
import { memoryPackToolManifests } from './memorypacks/manifests';
import { metaToolManifests } from './meta/manifests';
import { mobileToolManifests } from './mobile/manifests';
import { modelsToolManifests } from './models/manifests';
import { notifyToolManifests } from './notify/manifests';
import { pgToolManifests } from './pg/manifests';
import { redisToolManifests } from './redis/manifests';
import { reflexToolManifests } from './reflex/manifests';
import { rulesToolManifests } from './rules/manifests';
import { secretaryToolManifests } from './secretary/manifests';
import { serviceToolManifests } from './services/manifests';
import { settingsToolManifests } from './settings/manifests';
import { skillsToolManifests } from './skills/manifests';
import { slackToolManifests } from './slack/manifests';
import { uiToolManifests } from './ui/manifests';
import { workflowToolManifests } from './workflow/manifests';

import type { ToolManifest } from './registry';

export const allToolManifests: ToolManifest[] = [
  ...agentToolManifests,
  ...applescriptToolManifests,
  ...bookmarkToolManifests,
  ...bridgeToolManifests,
  ...browserToolManifests,
  ...calendarToolManifests,
  ...chatToolManifests,
  ...captureToolManifests,
  ...dockerToolManifests,
  ...extensionsToolManifests,
  ...episodicToolManifests,
  ...functionToolManifests,
  ...filesToolManifests,
  ...gdriveToolManifests,
  ...githubToolManifests,
  ...integrationsToolManifests,
  ...marketplaceToolManifests,
  ...memoryPackToolManifests,
  ...metaToolManifests,
  ...mobileToolManifests,
  ...modelsToolManifests,
  ...notifyToolManifests,
  ...pgToolManifests,
  ...redisToolManifests,
  ...rulesToolManifests,
  ...reflexToolManifests,
  ...ledgerToolManifests,
  ...secretaryToolManifests,
  ...serviceToolManifests,
  ...settingsToolManifests,
  ...skillsToolManifests,
  ...slackToolManifests,
  ...uiToolManifests,
  ...workflowToolManifests,
];
