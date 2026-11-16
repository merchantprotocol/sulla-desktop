// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Core routine — "Dreamer"
 *
 * The one and only scheduled memory consolidator. Every hour the schedule
 * trigger calls the `dream_recent_memories` tool, which hands the whole window
 * of v7 subject memories written since the last dream (capped at 24 h) to ONE
 * model call and appends the validated conclusions back into the v7 store.
 * See agent/memory/V7Dreamer.ts for the window, single-flight and skip rules.
 *
 * It replaces the per-domain nightly identity dreamers ("Dreaming About My
 * Human"), which read the legacy identity_observations table; those are
 * retired (archived + disabled, never deleted) by seedCoreRoutines.
 *
 * Locked core routine: re-asserted on every boot by the CoreRoutineSeeder;
 * visible and disable-able in Routines, not editable or deletable. The cadence
 * is the `dreamerIntervalMinutes` setting (default 60); the hourly trigger only
 * wakes the Dreamer, which skips ticks that are not due yet.
 */

export const DREAMER_ID = 'core-routine-dreamer';

/** The memory tool the Dreamer's single tool-call node runs. */
export const DREAMER_TOOL_NAME = 'dream_recent_memories';

export const DREAMER_DEFINITION: Record<string, any> = {
  id:          DREAMER_ID,
  name:        'Dreamer',
  description:
    'Hourly batch consolidation of memory. Reads the subject memories written since the last ' +
    'dream in one batch, makes one model call to consolidate themes, patterns and goals and to ' +
    'resolve contradictions, and writes the conclusions back to memory. Skips with zero model ' +
    'calls when nothing new was written. Locked core routine.',
  version:   1,
  enabled:   true,
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',

  edges: [
    { id: 'e-dreamer-trigger-dream', source: 'node-dreamer-trigger', target: 'node-dreamer-dream', animated: true },
    { id: 'e-dreamer-dream-done',    source: 'node-dreamer-dream',   target: 'node-dreamer-done',  animated: true },
  ],

  nodes: [
    {
      id:       'node-dreamer-trigger',
      type:     'workflow',
      position: { x: 400, y: 0 },
      data: {
        label:    'Hourly Trigger',
        category: 'trigger',
        subtype:  'schedule',
        config: {
          triggerType:        'schedule',
          triggerDescription: 'Wakes the Dreamer every hour; it dreams when the dreamerIntervalMinutes setting says it is due.',
          frequency:          'hourly',
          intervalMinutes:    0,
          hour:               0,
          minute:             5,
          dayOfWeek:          0,
          dayOfMonth:         1,
          timezone:           '',
        },
      },
    },
    {
      id:       'node-dreamer-dream',
      type:     'workflow',
      position: { x: 400, y: 130 },
      data: {
        label:    'Dream About Recent Memories',
        category: 'agent',
        subtype:  'tool-call',
        config: {
          toolName: DREAMER_TOOL_NAME,
          defaults: {},
        },
      },
    },
    {
      id:       'node-dreamer-done',
      type:     'workflow',
      position: { x: 400, y: 260 },
      data: {
        label:    'Done',
        category: 'io',
        subtype:  'response',
        config: {
          responseTemplate: 'Dreamer pass finished.',
        },
      },
    },
  ],

  viewport: { x: 0, y: 0, zoom: 1 },
};
