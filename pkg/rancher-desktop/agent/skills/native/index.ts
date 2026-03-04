import { nativeSkillRegistry } from './NativeSkillRegistry';
import { n8nWorkflowAutomationsSkill } from './n8n-workflow-automations';
import { softwareDevelopmentSkill } from './software-development';
import { projectManagementSkill } from './project-management';
import { gitOperationsSkill } from './git-operations';
import { remotionVideoGeneratorSkill } from './remotion-video-generator';
import { elevenlabsAudioGeneratorSkill } from './elevenlabs-audio-generator';
import { n8nWebhookTriggerWorkflowsSkill } from './n8n-webhook-trigger-workflows';
import { marketingPlanSkill } from './marketing-plan';
import { salesDevelopmentOutreachSkill } from './sales-development-outreach';
import { leadGenerationSkill } from './lead-generation';
import { facebookAdsSkill } from './facebook-ads';

// Register all native skills here
nativeSkillRegistry.register(n8nWorkflowAutomationsSkill);
nativeSkillRegistry.register(softwareDevelopmentSkill);
nativeSkillRegistry.register(projectManagementSkill);
nativeSkillRegistry.register(gitOperationsSkill);
nativeSkillRegistry.register(remotionVideoGeneratorSkill);
nativeSkillRegistry.register(elevenlabsAudioGeneratorSkill);
nativeSkillRegistry.register(n8nWebhookTriggerWorkflowsSkill);
nativeSkillRegistry.register(marketingPlanSkill);
nativeSkillRegistry.register(salesDevelopmentOutreachSkill);
nativeSkillRegistry.register(leadGenerationSkill);
nativeSkillRegistry.register(facebookAdsSkill);

export { nativeSkillRegistry };
