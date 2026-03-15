import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

import { CreateWorkspaceWorker, createWorkspaceRegistration } from '../create_workspace';

function configureWorker() {
  const worker = new CreateWorkspaceWorker() as any;
  worker.name = createWorkspaceRegistration.name;
  worker.description = createWorkspaceRegistration.description;
  worker.schemaDef = createWorkspaceRegistration.schemaDef;
  return worker;
}

describe('create_workspace tool', () => {
  it('creates a workspace directory for a valid workspace name', async() => {
    const worker = configureWorker();
    const workspaceName = `jest-create-workspace-${ Date.now() }`;
    const workspaceDir = path.join(
      os.homedir(),
      'workspaces',
      workspaceName,
    );

    const result = await worker.invoke({ name: workspaceName });

    expect(result.success).toBe(true);
    expect(result.result).toBe(workspaceDir);
    expect(fs.existsSync(workspaceDir)).toBe(true);
  });

  it('fails validation when workspace name is missing', async() => {
    const worker = configureWorker();

    await expect(worker.invoke({})).rejects.toThrow('Input validation failed');
    await expect(worker.invoke({})).rejects.toThrow('Missing required field: name');
  });
});
