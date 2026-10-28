// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// src/tools/index.ts
import { toolRegistry } from './registry';

// Side-effect import: lightweight manifest registration only (no worker imports)
import './manifests';

// Export convenience helpers (now async!)
export const getTool = (name: string) => toolRegistry.getTool(name);
export const getToolsByCategory = (cat: string) => toolRegistry.getToolsByCategory(cat);

// Primary tools export - meta category only
export const tools = toolRegistry.getLLMToolsForCategory('meta');

// For LangGraph agents – returns a function that loads on demand for all tools
export const createAgentTools = toolRegistry.getAllLLMTools();

// Export the registry itself for direct access
export { toolRegistry };
