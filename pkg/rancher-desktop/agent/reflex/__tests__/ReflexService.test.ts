import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ReflexExample } from '../ReflexEngine';

const settings: Record<string, string> = {};
const decisions: any[] = [];
let examples: ReflexExample[] = [];
const invoke = jest.fn(async() => ({ success: true, result: 'Opened "projects" tab in Sulla Desktop.' }));

jest.mock('../../database/models/ReflexModel', () => ({
  ReflexModel: {
    get version() { return examples.length },
    activeExamples: async() => examples,
    recordDecision: async(row: any) => { decisions.push(row); return `d${ decisions.length }` },
  },
}));
jest.mock('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: async(key: string, fallback: string) => settings[key] ?? fallback },
}));
jest.mock('../../tools/registry', () => ({
  toolRegistry: {
    getCategories:            () => ['ui', 'docker'],
    getToolNamesForCategory:  (c: string) => (c === 'ui' ? ['open_tab'] : ['docker_rm']),
    createTool:               async() => ({ invoke }),
  },
}));
jest.mock('../../services/DecisionService', () => ({
  decisionService: { requiresApproval: async(tool: string) => tool === 'docker_rm' },
}));

// eslint-disable-next-line import/first
import { formatReflexContext, runReflex } from '../ReflexService';

let n = 0;
const ex = (utterance: string, toolName: string, params: Record<string, unknown>): ReflexExample => ({
  id: `e${ ++n }`, utterance, toolName, params, positive: true,
});

describe('ReflexService hints', () => {
  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    decisions.length = 0;
    invoke.mockClear();
    examples = [
      ex('open projects', 'open_tab', { mode: 'projects' }),
      ex('open the projects page', 'open_tab', { mode: 'projects' }),
      ex('open the vault', 'open_tab', { mode: 'vault' }),
      ex('delete the postgres container', 'docker_rm', { name: 'postgres' }),
    ];
  });

  it('acts at or above the threshold', async() => {
    const r = await runReflex('open projects', {});
    expect(r?.kind).toBe('acted');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('hands the model a hint between the hint floor and the threshold, running nothing', async() => {
    const r = await runReflex('open up the project management system', {});
    expect(invoke).not.toHaveBeenCalled();
    expect(r?.kind).toBe('hint');
    expect(decisions[0].status).toBe('below_threshold');
    const text = formatReflexContext(r!);
    expect(text).toContain('did NOT act');
    expect(text).toContain(`sulla ui/open_tab '{"mode":"projects"}'`);
    expect(text).toContain('Nothing has run');
  });

  it('stays silent below the hint floor', async() => {
    settings.reflexHintThreshold = '0.99';
    expect(await runReflex('open up the project management system', {})).toBeNull();
    expect(decisions).toHaveLength(1);
  });

  it('turns a policy-blocked match into a hint that names the reason', async() => {
    const r = await runReflex('delete the postgres container', {});
    expect(invoke).not.toHaveBeenCalled();
    expect(r?.kind).toBe('hint');
    expect(decisions[0].status).toBe('blocked');
    expect(formatReflexContext(r!)).toContain('did NOT run it (');
  });
});
