import { describe, expect, it } from '@jest/globals';

import { decisionKey, REFLEX_NONE, ReflexEngine, type ReflexExample } from '../ReflexEngine';

const doctor = { url: 'http://localhost:5199' };
let n = 0;
const ex = (utterance: string, toolName: string, params: Record<string, unknown> = {}, positive = true): ReflexExample => ({
  id: `e${ ++n }`, utterance, toolName, params, positive,
});

const base: ReflexExample[] = [
  ex('open the doctor container in my browser', 'tab', doctor),
  ex('open doctor in the browser', 'tab', doctor),
  ex('pull up the doctor container', 'tab', doctor),
  ex('open projects', 'open_tab', { mode: 'projects' }),
  ex('show me my projects', 'open_tab', { mode: 'projects' }),
  ex('open the vault', 'open_tab', { mode: 'vault' }),
  ex('what does the doctor container do', REFLEX_NONE),
];

describe('ReflexEngine', () => {
  it('acts with high confidence on a close paraphrase of a known request', () => {
    const p = new ReflexEngine(base).predict('hey sulla open up the doctor container in my browser');
    expect(p.toolName).toBe('tab');
    expect(p.params).toEqual(doctor);
    expect(p.confidence).toBeGreaterThan(0.85);
  });

  it('distinguishes targets that share a verb', () => {
    const engine = new ReflexEngine(base);
    expect(engine.predict('open the vault please').params).toEqual({ mode: 'vault' });
    expect(engine.predict('show me my projects').params).toEqual({ mode: 'projects' });
  });

  it('does not act on unrelated messages', () => {
    const p = new ReflexEngine(base).predict('draft an email to Carleigh about dinner');
    expect(p.toolName).toBe(REFLEX_NONE);
    expect(p.confidence).toBe(0);
  });

  it('prefers the learned "none" for questions about a known target', () => {
    const p = new ReflexEngine(base).predict('what does the doctor container do');
    expect(p.toolName).toBe(REFLEX_NONE);
  });

  it('counter-examples veto a decision', () => {
    const engine = new ReflexEngine([
      ...base,
      ex('open the doctor container in my browser', 'tab', doctor, false),
      ex('open the doctor container in my browser', 'tab', doctor, false),
    ]);
    const p = engine.predict('open the doctor container in my browser');
    expect(p.toolName === REFLEX_NONE || p.confidence < 0.85).toBe(true);
  });

  it('lowers confidence when similar examples disagree', () => {
    const engine = new ReflexEngine([
      ex('open the dashboard', 'tab', { url: 'http://localhost:3000' }),
      ex('open the dashboard', 'tab', { url: 'http://localhost:4000' }),
    ]);
    expect(engine.predict('open the dashboard').confidence).toBeLessThanOrEqual(0.5);
  });

  it('refuses long conversational messages and empty input', () => {
    const engine = new ReflexEngine(base);
    expect(engine.predict('').toolName).toBe(REFLEX_NONE);
    expect(engine.predict(`open the doctor container ${ 'and then think about it '.repeat(15) }`).toolName).toBe(REFLEX_NONE);
  });

  it('knows nothing before training', () => {
    expect(new ReflexEngine([]).predict('open projects').reason).toBe('no training examples yet');
  });

  it('keys decisions independent of param key order', () => {
    expect(decisionKey('tab', { a: 1, b: { d: 2, c: 3 } })).toBe(decisionKey('tab', { b: { c: 3, d: 2 }, a: 1 }));
  });
});
