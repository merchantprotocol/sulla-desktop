// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { expect, it } from 'vitest';

import { formatToolResult } from '@pkg/agent/tools/toolCardFormatters';
import { ToolResultCardProjector } from '@pkg/agent/database/models/ToolResultCardProjector';

// risk: performance and data accuracy — a 5 MB result must remain complete in the durable log, not duplicated inline in chat state.
it('keeps a 5 MB result as a bounded reference with no second card copy', () => {
  const card = { toolRunId: 'run-5mb', toolName: 'exec', status: 'running' as const, args: {} };
  const result = `RESULT_START:${ 'x'.repeat(5_000_000) }:RESULT_END`;

  new ToolResultCardProjector(formatToolResult).project(card, { success: true, result }, 'thread-5mb');

  expect(card).toMatchObject({ status: 'success', toolPayloadRef: { threadId: 'thread-5mb', toolRunId: 'run-5mb' } });
  expect(card).not.toHaveProperty('result');
  expect(card).not.toHaveProperty('output');
  expect(JSON.stringify(card).length).toBeLessThan(1_000);
});

// risk: image visibility — even a small inline image must stay in the durable log and load as an image on expansion, not persist as base64 text.
it('stores inline image blocks by reference even below the text payload threshold', () => {
  const card = { toolRunId: 'run-image', toolName: 'browser', status: 'running' as const, args: {} };
  const image = 'IMAGE_BYTES_DO_NOT_PERSIST';
  const result = { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] };

  new ToolResultCardProjector(formatToolResult).project(card, { success: true, result }, 'thread-image');

  expect(card).toMatchObject({ status: 'success', toolPayloadRef: { threadId: 'thread-image', toolRunId: 'run-image' } });
  expect(card).not.toHaveProperty('result');
  expect(card).not.toHaveProperty('output');
  expect(JSON.stringify(card)).not.toContain(image);
});
