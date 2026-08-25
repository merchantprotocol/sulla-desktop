/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { ArchivePipelineTemplateWorker } from '../archive_pipeline_template';
import { projectToolManifests } from '../manifests';
import { UpdatePipelineTemplateWorker } from '../update_pipeline_template';

describe('pipeline template edit manifests', () => {
  it('registers update_pipeline_template and archive_pipeline_template', () => {
    const names = new Set(projectToolManifests.map(tool => tool.name));
    expect(names.has('update_pipeline_template')).toBe(true);
    expect(names.has('archive_pipeline_template')).toBe(true);
  });

  it('loads both new workers through their manifest loader', async() => {
    const targets = projectToolManifests.filter(tool =>
      ['update_pipeline_template', 'archive_pipeline_template'].includes(tool.name));
    expect(targets).toHaveLength(2);
    for (const tool of targets) {
      const module = await tool.loader();
      expect(Object.values(module).some((value: any) =>
        typeof value === 'function' && typeof value.prototype?._validatedCall === 'function')).toBe(true);
    }
  });
});

const projects = getProjectsApplicationService() as any;
const updateTemplate = jest.spyOn(projects, 'updateProjectPipelineTemplate');
const archiveTemplate = jest.spyOn(projects, 'archiveProjectPipelineTemplate');
const call = (tool: any, input: any) => tool._validatedCall(input);

describe('update_pipeline_template workflow tool', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires template_id', async() => {
    expect((await call(new UpdatePipelineTemplateWorker(), { name: 'New name' })).successBoolean).toBe(false);
    expect(updateTemplate).not.toHaveBeenCalled();
  });

  it('renames without touching stages when none are provided', async() => {
    updateTemplate.mockResolvedValue({ id: 'custom', name: 'Renamed' });
    const result = await call(new UpdatePipelineTemplateWorker(), { template_id: 'custom', name: 'Renamed', actor: 'human' });
    expect(result.successBoolean).toBe(true);
    expect(updateTemplate).toHaveBeenCalledWith('custom', {
      name: 'Renamed', description: undefined, stages: undefined, actor: 'human',
    }, { actor: 'human', source: 'tool' });
  });

  it('maps a full replacement stage graph through the application boundary', async() => {
    updateTemplate.mockResolvedValue({ id: 'custom', stages: [] });
    const result = await call(new UpdatePipelineTemplateWorker(), {
      template_id: 'custom',
      stages: [{ stage_key: 'research', display_name: 'Research', position: 10, workflow_id: 'research-routine' }],
    });
    expect(result.successBoolean).toBe(true);
    expect(updateTemplate).toHaveBeenCalledWith('custom', expect.objectContaining({
      stages: [expect.objectContaining({ stageKey: 'research', position: 10, workflowId: 'research-routine' })],
    }), expect.anything());
  });

  it('surfaces a locked-template rejection as a failed tool result', async() => {
    updateTemplate.mockRejectedValue(new Error('Core pipeline template core-project-template-default cannot be edited.'));
    const result = await call(new UpdatePipelineTemplateWorker(), { template_id: 'core-project-template-default', name: 'x' });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('cannot be edited');
  });
});

describe('archive_pipeline_template workflow tool', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('requires template_id', async() => {
    expect((await call(new ArchivePipelineTemplateWorker(), {})).successBoolean).toBe(false);
    expect(archiveTemplate).not.toHaveBeenCalled();
  });

  it('archives through the application boundary', async() => {
    archiveTemplate.mockResolvedValue({ id: 'custom', archived_at: '2026-08-25T00:00:00Z' });
    const result = await call(new ArchivePipelineTemplateWorker(), { template_id: 'custom', actor: 'human' });
    expect(result.successBoolean).toBe(true);
    expect(archiveTemplate).toHaveBeenCalledWith('custom', { actor: 'human', source: 'tool' });
  });

  it('reports a missing template as a failed tool result', async() => {
    archiveTemplate.mockResolvedValue(null);
    const result = await call(new ArchivePipelineTemplateWorker(), { template_id: 'missing' });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('not found');
  });

  it('surfaces a locked-template rejection as a failed tool result', async() => {
    archiveTemplate.mockRejectedValue(new Error('Core pipeline template core-project-template-default cannot be archived.'));
    const result = await call(new ArchivePipelineTemplateWorker(), { template_id: 'core-project-template-default' });
    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('cannot be archived');
  });
});
