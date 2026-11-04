// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class WorkflowToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  execute_workflow(args) {
    return { label: 'Workflow', summary: `Running workflow ${ text.string(args.workflowId) }` };
  },
  validate_workflow(args) {
    return { label: 'Workflow', summary: `Validating workflow ${ text.string(args.workflowId) }` };
  },
  validate_workflow_payload(args) {
    return { label: 'Workflow', summary: `Validating payload: ${ text.truncate(text.string(args.name), 40) }` };
  },
  patch_workflow(args) {
    const ops = Array.isArray(args.operations) ? args.operations.length : '?';
    return { label: 'Workflow', summary: `Patching workflow ${ text.string(args.workflowId) } (${ ops } operations)` };
  },
  diagnose_webhook(args) {
    return { label: 'Workflow', summary: `Diagnosing webhook for ${ text.string(args.workflowId) }` };
  },
  restart_from_checkpoint(args) {
    return { label: 'Workflow', summary: `Restarting from node ${ text.string(args.nodeId) }` };
  },
    });
  }
}
