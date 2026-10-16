import { getSullaFilesService } from '../../files/runtime';
import { BaseTool } from '../base';

import type { ToolExecutionContext } from '../executionContext';

export const filesService = getSullaFilesService;

export abstract class FilesTool extends BaseTool {
  protected context(_input?: unknown): ToolExecutionContext {
    if (!this.executionContext) throw new Error('Files tools require a verified ToolExecutionContext');
    return this.executionContext;
  }
}
