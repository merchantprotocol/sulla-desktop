// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolManifest } from '../registry';

const load = () => import('./desktop');

export const desktopToolManifests: ToolManifest[] = [
  {
    name: 'permissions',
    description: 'Report macOS Accessibility and Screen Recording permission state. guide:true opens System Settings; it never grants or bypasses permission.',
    category: 'desktop',
    schemaDef: { guide: { type: 'boolean', optional: true, description: 'Open the official permission guide in System Settings.' } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'list_apps',
    description: 'List running Mac applications.',
    category: 'desktop',
    schemaDef: { app: { type: 'string', optional: true, description: 'Optional app-name filter.' } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'list_windows',
    description: 'List Mac application windows and stable window IDs.',
    category: 'desktop',
    schemaDef: { app: { type: 'string', optional: true, description: 'Optional exact app-name filter.' } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'snapshot',
    description: 'Snapshot one app accessibility tree and return the agent-desktop JSON envelope with qualified refs.',
    category: 'desktop',
    schemaDef: { app: { type: 'string', description: 'Application name.' }, window_id: { type: 'string', optional: true, description: 'Window ID from list_windows.' }, interactive_only: { type: 'boolean', optional: true, description: 'Default true; include interactive elements only.' }, compact: { type: 'boolean', optional: true, description: 'Collapse unnamed single-child nodes.' }, skeleton: { type: 'boolean', optional: true, description: 'Return a shallow structural overview.' }, root: { type: 'string', optional: true, description: 'Qualified ref whose subtree to snapshot.' } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'find',
    description: 'Find accessible elements in an app by semantic properties.',
    category: 'desktop',
    schemaDef: { app: { type: 'string', description: 'Application name.' }, window_id: { type: 'string', optional: true }, role: { type: 'string', optional: true }, name: { type: 'string', optional: true }, value: { type: 'string', optional: true }, text: { type: 'string', optional: true }, description: { type: 'string', optional: true }, native_id: { type: 'string', optional: true }, root: { type: 'string', optional: true }, limit: { type: 'number', optional: true } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'get',
    description: 'Read a property from a qualified snapshot ref.',
    category: 'desktop',
    schemaDef: { ref: { type: 'string', description: 'Qualified ref, e.g. @s8f3k2p9:e8.' }, property: { type: 'enum', enum: ['text','value','title','bounds','role','states'], optional: true } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'act',
    description: 'Perform one semantic accessibility action on a qualified ref. Re-snapshot after acting; STALE_REF means take a fresh snapshot. Headless by default. headed:true moves the user\'s real pointer/keyboard; check the user is idle first.',
    category: 'desktop',
    schemaDef: { action: { type: 'enum', enum: ['click','double_click','right_click','type','set_value','clear','focus','select','toggle','check','uncheck','expand','collapse','scroll','scroll_to','press'] }, ref: { type: 'string', description: 'Qualified ref from this tool session.' }, text: { type: 'string', optional: true }, value: { type: 'string', optional: true }, keys: { type: 'string', optional: true, description: 'Key combo for press.' }, direction: { type: 'enum', enum: ['up','down','left','right'], optional: true }, amount: { type: 'number', optional: true }, headed: { type: 'boolean', optional: true, description: "Moves the user's real pointer/keyboard; check the user is idle first." } },
    operationTypes: ['execute'],
    loader: load,
  },
  {
    name: 'screenshot',
    description: 'Save an app/window screenshot to a local path and return its path, not transcript base64.',
    category: 'desktop',
    schemaDef: { app: { type: 'string', description: 'Application name.' }, window_id: { type: 'string', optional: true }, path: { type: 'string', optional: true, description: 'Output PNG path; a private temporary path is used by default.' } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'app',
    description: 'Launch, close, focus, resize, move, minimize, maximize, or restore a Mac app/window.',
    category: 'desktop',
    schemaDef: { action: { type: 'enum', enum: ['launch','close_app','focus_window','resize','move','minimize','maximize','restore'] }, app: { type: 'string', optional: true }, window_id: { type: 'string', optional: true }, title: { type: 'string', optional: true }, width: { type: 'number', optional: true }, height: { type: 'number', optional: true }, x: { type: 'number', optional: true }, y: { type: 'number', optional: true } },
    operationTypes: ['execute'],
    loader: load,
  },
  {
    name: 'clipboard',
    description: 'Get, set, or clear the macOS clipboard.',
    category: 'desktop',
    schemaDef: { action: { type: 'enum', enum: ['get','set','clear'] }, text: { type: 'string', optional: true, description: 'Required only for set.' } },
    operationTypes: ['execute'],
    loader: load,
  },
  {
    name: 'wait',
    description: 'Wait for a duration or accessible element, window, or text.',
    category: 'desktop',
    schemaDef: { ms: { type: 'number', optional: true }, element: { type: 'string', optional: true }, window: { type: 'string', optional: true }, text: { type: 'string', optional: true }, app: { type: 'string', optional: true }, timeout: { type: 'number', optional: true } },
    operationTypes: ['read'],
    loader: load,
  },
  {
    name: 'guide',
    description: 'Return the version-matched agent-desktop desktop and platform skills for the snapshot-act-snapshot loop.',
    category: 'desktop',
    schemaDef: {},
    operationTypes: ['read'],
    loader: load,
  },
];
