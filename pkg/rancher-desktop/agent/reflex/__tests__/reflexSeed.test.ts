/**
 * Ship gate for the Reflex seed (seed/reflex-seed.json).
 *
 * The seed is trained WITHOUT the fixture phrasings, then scored at the
 * default threshold on two held-out sets of newcomer messages: requests that
 * should act, and messages Reflex must leave to the model (chit-chat, tasks
 * that mention an app, complaints about a feature). Any wrong action or false
 * fire fails the build; recall floors guard against regressions.
 *
 * Also run the offline real-traffic check before changing the seed or engine:
 * the calibration used ~2.7k real chat messages, which can't live in the repo.
 */
import { describe, expect, it } from '@jest/globals';

import { DEFAULT_REFLEX_THRESHOLD, DEFAULT_REFLEX_CATEGORIES, reflexPolicyViolation } from '../reflexPolicy';
import { canonicalize } from '../reflexSynonyms';
import devSet from './fixtures/newcomer-dev.json';
import testSet from './fixtures/newcomer-test.json';
import { browserToolManifests } from '../../tools/browser/manifests';
import { captureToolManifests } from '../../tools/capture/manifests';
import { dockerToolManifests } from '../../tools/docker/manifests';
import { notifyToolManifests } from '../../tools/notify/manifests';
import { projectToolManifests } from '../../tools/project/manifests';
import { secretaryToolManifests } from '../../tools/secretary/manifests';
import { uiToolManifests } from '../../tools/ui/manifests';
import { REFLEX_NONE, ReflexEngine } from '../ReflexEngine';
import seed from '../seed/reflex-seed.json';

interface Case { utterance: string; tool: string; params: Record<string, unknown> }

// open_tab modes (tab modes + the settings/models/audio windows).
const OPEN_TAB_MODES = ['chat', 'marketplace', 'integrations', 'vault', 'routines', 'history', 'secretary', 'document', 'browser',
  'welcome', 'agents', 'projects', 'decide', 'settings', 'models', 'audio'];

const manifests = [...uiToolManifests, ...browserToolManifests, ...captureToolManifests, ...dockerToolManifests,
  ...notifyToolManifests, ...projectToolManifests, ...secretaryToolManifests];
const categoryOf = (name: string) => manifests.filter(m => m.name === name).map(m => m.category);

function score(cases: Case[]) {
  const held = new Set(cases.map(c => c.utterance.toLowerCase()));
  const engine = new ReflexEngine(seed.examples
    .filter(e => !held.has(e.utterance.toLowerCase()))
    .map((e, i) => ({ id: String(i), utterance: e.utterance, toolName: e.tool, params: e.params, positive: e.positive })));
  let correct = 0; let shouldAct = 0;
  const mistakes: string[] = [];
  for (const c of cases) {
    const p = engine.predict(c.utterance);
    const acts = p.toolName !== REFLEX_NONE && p.confidence >= DEFAULT_REFLEX_THRESHOLD;
    const right = p.toolName === c.tool && Object.entries(c.params).every(([k, v]) => JSON.stringify(p.params[k]) === JSON.stringify(v));
    if (c.tool === REFLEX_NONE) {
      if (acts) mistakes.push(`false fire: "${ c.utterance }" → ${ p.toolName } ${ JSON.stringify(p.params) } (${ p.confidence })`);
      continue;
    }
    shouldAct++;
    if (acts && right) correct++;
    else if (acts) mistakes.push(`wrong action: "${ c.utterance }" → ${ p.toolName } ${ JSON.stringify(p.params) } (${ p.confidence })`);
  }
  return { recall: correct / shouldAct, mistakes };
}

describe('Reflex seed', () => {
  it('only uses registered, policy-allowed tools with unambiguous names', () => {
    for (const e of seed.examples) {
      if (e.tool === REFLEX_NONE) continue;
      const cats = categoryOf(e.tool);
      expect(cats).toHaveLength(1);
      if (e.positive) {
        expect(reflexPolicyViolation({ toolName: e.tool, category: cats[0], params: e.params, allowedCategories: DEFAULT_REFLEX_CATEGORIES })).toBeNull();
      }
      if (e.tool === 'open_tab') expect(OPEN_TAB_MODES).toContain((e.params as { mode?: string }).mode);
    }
  });

  it('holds no duplicate examples', () => {
    const keys = seed.examples.map(e => `${ e.utterance.toLowerCase() }|${ e.tool }|${ JSON.stringify(e.params) }|${ e.positive }`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('makes no wrong action and no false fire on held-out newcomer messages', () => {
    expect(score(testSet as Case[]).mistakes).toEqual([]);
    expect(score(devSet as Case[]).mistakes).toEqual([]);
  });

  it('handles at least the calibrated share of newcomer requests', () => {
    expect(score(testSet as Case[]).recall).toBeGreaterThanOrEqual(0.45);
    expect(score(devSet as Case[]).recall).toBeGreaterThanOrEqual(0.55);
  });

  it('maps newcomer vocabulary onto one concept', () => {
    expect(canonicalize('what LLM is this')).toBe('what model is this');
    expect(canonicalize('is the note-taker on')).toBe('is the secretary on');
    expect(canonicalize('where do I store my API keys')).toBe('where do i store my vault');
  });
});
