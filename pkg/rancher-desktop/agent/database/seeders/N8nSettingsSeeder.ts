import { N8nSettingsModel } from '../models/N8nSettingsModel';
import { N8nWorkflowModel } from '../models/N8nWorkflowModel';

async function initialize(): Promise<void> {
  console.log('[N8nSettingsSeeder] Starting...');

  const key = 'mcp';
  const value = JSON.stringify({ enabled: true });
  const loadOnStartup = true;

  const existing = await N8nSettingsModel.find(key);

  if (existing) {
    existing.attributes.value = value;
    existing.attributes.loadOnStartup = loadOnStartup;
    await existing.save();
    console.log('[N8nSettingsSeeder] Updated mcp setting');
  } else {
    await N8nSettingsModel.create({
      key,
      value,
      loadOnStartup,
    });

    console.log('[N8nSettingsSeeder] Created mcp setting');
  }

  const workflows = await N8nWorkflowModel.all();
  let updatedCount = 0;

  for (const workflow of workflows) {
    const currentSettings = workflow.attributes.settings && typeof workflow.attributes.settings === 'object'
      ? { ...(workflow.attributes.settings) }
      : {};

    if (currentSettings.availableInMCP === true) {
      continue;
    }

    currentSettings.availableInMCP = true;
    workflow.attributes.settings = currentSettings;
    await workflow.save();
    updatedCount += 1;
  }

  console.log(`[N8nSettingsSeeder] Updated workflows for MCP visibility: ${ updatedCount }`);
}

export { initialize };
