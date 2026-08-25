/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { ApplyPipelineTemplateWorker } from '../apply_pipeline_template';
import { CreatePipelineTemplateWorker } from '../create_pipeline_template';
import { ListPipelineTemplatesWorker } from '../list_pipeline_templates';

const projects = getProjectsApplicationService() as any;
const listTemplates = jest.spyOn(projects, 'listProjectPipelineTemplates');
const getTemplate = jest.spyOn(projects, 'getProjectPipelineTemplate');
const createTemplate = jest.spyOn(projects, 'createProjectPipelineTemplate');
const applyTemplate = jest.spyOn(projects, 'applyProjectPipelineTemplate');
const call = (tool: any, input: any) => tool._validatedCall(input);

describe('project pipeline template tools', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('lists templates and drills into one ordered definition', async() => {
    listTemplates.mockResolvedValue([{ id: 'core-project-template-default', locked: true }]);
    expect((await call(new ListPipelineTemplatesWorker(), {})).successBoolean).toBe(true);
    expect(listTemplates).toHaveBeenCalledWith(false);
    getTemplate.mockResolvedValue({ id: 'custom', stages: [{ stage_key: 'research', position: 10 }] });
    expect((await call(new ListPipelineTemplatesWorker(), { template_id: 'custom' })).successBoolean).toBe(true);
    expect(getTemplate).toHaveBeenCalledWith('custom');
  });

  it('maps a custom ordered stage graph through the application boundary', async() => {
    createTemplate.mockResolvedValue({ id: 'custom', stages: [] });
    const result = await call(new CreatePipelineTemplateWorker(), {
      template_key: 'publishing', name: 'Publishing', actor: 'human',
      stages: [{ stage_key: 'research', display_name: 'Research', position: 10, workflow_id: 'research-routine' }],
    });
    expect(result.successBoolean).toBe(true);
    expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'publishing', stages: [expect.objectContaining({
        stageKey: 'research', position: 10, workflowId: 'research-routine',
      })],
    }), { actor: 'human', source: 'tool' });
  });

  it('requires explicit custody when applying a template to a project', async() => {
    expect((await call(new ApplyPipelineTemplateWorker(), { project_id: 'project-1' })).successBoolean).toBe(false);
    applyTemplate.mockResolvedValue({ id: 'custom', name: 'Publishing' });
    const result = await call(new ApplyPipelineTemplateWorker(), {
      project_id: 'project-1', template_id: 'custom', actor: 'human',
    });
    expect(result.successBoolean).toBe(true);
    expect(applyTemplate).toHaveBeenCalledWith('project-1', 'custom', { actor: 'human', source: 'tool' });
  });
});
