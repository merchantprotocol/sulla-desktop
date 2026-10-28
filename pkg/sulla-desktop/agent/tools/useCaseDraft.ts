// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolResponse } from './base';
import { FilesTool, writeUseCaseDraft } from './files/common';

export function draftResponse(type: 'agents' | 'skills' | 'workflows' | 'functions' | 'recipes', slug: string, files: Record<string, string>, written: Awaited<ReturnType<typeof writeUseCaseDraft>>): ToolResponse {
  const primary = written[0];
  return {
    successBoolean: true,
    responseString: JSON.stringify({
      status: 'draft',
      type,
      slug,
      files,
      file_id: primary?.fileId,
      version_id: primary?.versionId,
      files_written: written,
      next: 'Call files_request_publish with the file_id and version_id when the draft is ready for human approval.',
    }),
  };
}

export { FilesTool, writeUseCaseDraft };
