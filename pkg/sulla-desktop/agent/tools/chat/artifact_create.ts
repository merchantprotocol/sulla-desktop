// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatArtifactTool } from './artifact_common';
import { projectFileInput } from './projectFile';

export class ArtifactCreateWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const projectFile = projectFileInput(input);
    const result = await this.service().create(this.threadId(), {
      name: input.name,
      kind: input.kind,
      content: projectFile?.content ?? input.content,
      status: input.status,
      language: input.language,
      path: projectFile?.path ?? input.path,
      author: 'agent',
      focus: input.focus !== false,
      expectedVersion: this.expectedVersion(input),
    });
    return this.response(result.created ? 'Created artifact' : 'Updated existing artifact with the same name', result.artifact, true);
  }
}
