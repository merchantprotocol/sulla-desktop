import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { flushPromises, mount } from '@vue/test-utils';

import StartupProgressPanel from '../StartupProgressPanel.vue';
import StartupShowcase from '../StartupShowcase.vue';
import { SHOWCASE_MODEL_NAMES, SHOWCASE_SLIDES, loadIntegrationCount, slideTitle } from '../startupShowcaseSlides';

import { nativeIntegrations } from '@pkg/agent/integrations/native';
import { StartupProgressModel, type StartupProgressSnapshot } from '@pkg/utils/startupProgress';

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable:     true,
    value:        (query: string) => ({
      matches: query.includes('reduce') ? matches : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    }),
  });
}

function snapshotAt(t0: number): StartupProgressSnapshot {
  const model = new StartupProgressModel(() => t0);

  model.onLifecycleBegin(['postgres', 'vault', 'sulla-files-runtime']);
  model.onLifecycleStep({ name: 'postgres', status: 'start' });
  model.onLifecycleStep({ name: 'postgres', status: 'ready', durationMs: 1500 });
  model.onLifecycleStep({ name: 'vault', status: 'start' });
  model.onLifecycleStep({ name: 'vault', status: 'ready', durationMs: 900 });
  model.onLifecycleStep({ name: 'sulla-files-runtime', status: 'start' });

  return model.snapshot();
}

beforeEach(() => {
  jest.useFakeTimers();
  setReducedMotion(false);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('StartupProgressPanel', () => {
  it('renders stage, step, step count, elapsed time, and no checklist', async() => {
    const t0 = 1_000_000;
    const now = t0 + 65_000;
    const w = mount(StartupProgressPanel, { props: { snapshot: snapshotAt(t0), now: () => now } });

    jest.advanceTimersByTime(1000);
    await flushPromises();

    expect(w.get('[data-test="stage"]').text()).toContain('Stage 3 of 3');
    expect(w.get('[data-test="stage"]').text()).toContain('Bringing features online');
    expect(w.get('[data-test="step"]').text()).toBe('Unlocking Files');
    expect(w.get('[data-test="step-meta"]').text()).toContain('Step 3 of 3');
    expect(w.get('[data-test="elapsed"]').text()).toBe('1m 05s');
    // The finished-steps checklist is gone: it only added a scrollbar.
    expect(w.find('[data-test="feed"]').exists()).toBe(false);
    // 65 s on the Files step: the slow note explains what it is doing.
    expect(w.get('[data-test="slow-note"]').text()).toMatch(/taking a while.*background/s);
    w.unmount();
  });

  it('shows the failure calmly with the step name and a retry hint', () => {
    const model = new StartupProgressModel(() => 10);

    model.onLifecycleBegin(['vault']);
    model.onLifecycleStep({ name: 'vault', status: 'start' });
    model.onLifecycleStep({ name: 'vault', status: 'failed', durationMs: 5, error: 'key missing' });
    const w = mount(StartupProgressPanel, { props: { snapshot: model.snapshot(), now: () => 20 } });

    const box = w.get('[data-test="failures"]');

    expect(box.text()).toContain('Starting the vault');
    expect(box.text()).toContain('key missing');
    expect(box.text()).toContain('Restarting Sulla');
    w.unmount();
  });

  it('never moves the displayed percent backward and creeps while a step runs', async() => {
    const t0 = 1_000_000;
    let now = t0;
    const snap = snapshotAt(t0);
    const w = mount(StartupProgressPanel, { props: { snapshot: snap, now: () => now } });
    const vm = w.vm;
    const values: number[] = [];

    for (let s = 0; s < 60; s++) {
      now += 1000;
      vm.advance(1000);
      values.push(vm.displayed);
    }
    expect(values.every((v, i) => i === 0 || v >= values[i - 1])).toBe(true);
    expect(values.at(-1)).toBeGreaterThan(snap.percent);
    expect(values.at(-1)).toBeLessThan(snap.nextBoundary);

    // An older, lower snapshot must not pull the bar back.
    await w.setProps({ snapshot: { ...snap, percent: 10, nextBoundary: 12 } });
    vm.advance(1000);
    expect(vm.displayed).toBeGreaterThanOrEqual(values.at(-1)!);
    w.unmount();
  });

  it('keeps moving on the 1 s ticker when animation frames stop (backgrounded window)', () => {
    const realRaf = window.requestAnimationFrame;

    window.requestAnimationFrame = () => 1; // frames never run
    try {
      const t0 = Date.now();
      const snap = snapshotAt(t0);
      const w = mount(StartupProgressPanel, { props: { snapshot: snap, now: () => Date.now() } });

      jest.advanceTimersByTime(5000);
      const at5 = (w.vm).displayed;

      jest.advanceTimersByTime(5000);
      expect(at5).toBeGreaterThan(0);
      expect((w.vm).displayed).toBeGreaterThan(at5);
      w.unmount();
    } finally {
      window.requestAnimationFrame = realRaf;
    }
  });

  it('reduced motion: jumps to the real target and does not creep', async() => {
    setReducedMotion(true);
    const t0 = 1_000_000;
    let now = t0;
    const snap = snapshotAt(t0);
    const w = mount(StartupProgressPanel, { props: { snapshot: snap, now: () => now } });
    const vm = w.vm;

    expect(vm.reducedMotion).toBe(true);
    now += 60_000;
    vm.advance(60_000);
    await flushPromises();
    expect(vm.displayed).toBe(snap.percent);
    expect(w.get('[data-test="fill"]').classes()).not.toContain('moving');
    w.unmount();
  });
});

describe('StartupShowcase', () => {
  const mountShowcase = async(props: Record<string, unknown> = {}) => {
    const w = mount(StartupShowcase, { props: { countLoader: () => Promise.resolve(317), intervalMs: 6000, ...props }, attachTo: document.body });

    jest.advanceTimersByTime(20); // first-paint deferral
    await flushPromises();

    return w;
  };

  it('advances on its timer', async() => {
    const w = await mountShowcase();

    expect(w.get('[data-test="slide-title"]').text()).toBe(SHOWCASE_SLIDES[0].title);
    jest.advanceTimersByTime(6100); // interval + the next frame
    await flushPromises();
    expect(w.get('[data-test="slide-title"]').text()).toBe(slideTitle(SHOWCASE_SLIDES[1], { integrationCount: 317 }));
    w.unmount();
  });

  it('pauses while hovered and resumes after', async() => {
    const w = await mountShowcase();

    await w.get('[data-test="showcase"]').trigger('mouseenter');
    jest.advanceTimersByTime(20_000);
    await flushPromises();
    expect((w.vm).index).toBe(0);
    await w.get('[data-test="showcase"]').trigger('mouseleave');
    jest.advanceTimersByTime(6100); // interval + the next frame
    await flushPromises();
    expect((w.vm).index).toBe(1);
    w.unmount();
  });

  it('supports arrows, dots and keyboard navigation with labelled controls', async() => {
    const w = await mountShowcase();
    const region = w.get('[data-test="showcase"]');

    expect(region.attributes('aria-label')).toBe('What Sulla can do');
    expect(w.find('[aria-live="polite"]').exists()).toBe(true);
    expect(w.get('[data-test="next"]').attributes('aria-label')).toBe('Next feature');
    await region.trigger('keydown', { key: 'ArrowRight' });
    expect((w.vm).index).toBe(1);
    await region.trigger('keydown', { key: 'ArrowLeft' });
    await region.trigger('keydown', { key: 'ArrowLeft' });
    expect((w.vm).index).toBe(SHOWCASE_SLIDES.length - 1);
    await w.findAll('[data-test="dot"]')[3].trigger('click');
    expect((w.vm).index).toBe(3);
    expect(w.findAll('[data-test="dot"]')[3].attributes('aria-current')).toBe('true');
    await w.get('[data-test="prev"]').trigger('click');
    expect((w.vm).index).toBe(2);
    w.unmount();
  });

  it('does not autoplay when reduced motion is requested', async() => {
    setReducedMotion(true);
    const w = await mountShowcase();

    jest.advanceTimersByTime(60_000);
    await flushPromises();
    expect((w.vm).index).toBe(0);
    await w.get('[data-test="showcase"]').trigger('keydown', { key: 'ArrowRight' });
    expect((w.vm).index).toBe(1);
    w.unmount();
  });

  it('pauses when the window is hidden', async() => {
    const w = await mountShowcase();

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(30_000);
    await flushPromises();
    expect((w.vm).index).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    w.unmount();
  });

  it('shows the integration count from the catalog loader', async() => {
    const i = SHOWCASE_SLIDES.findIndex(s => s.id === 'integrations');
    const w = await mountShowcase();

    await w.findAll('[data-test="dot"]')[i].trigger('click');
    expect(w.get('[data-test="slide-title"]').text()).toBe('317 integrations, built in.');
    w.unmount();
  });
});

describe('showcase slide data', () => {
  it('has more than 7 slides, each with id, eyebrow, title, body, art and sources', () => {
    expect(SHOWCASE_SLIDES.length).toBeGreaterThan(7);
    expect(SHOWCASE_SLIDES.length).toBeLessThanOrEqual(12);
    expect(new Set(SHOWCASE_SLIDES.map(s => s.id)).size).toBe(SHOWCASE_SLIDES.length);
    for (const slide of SHOWCASE_SLIDES) {
      expect(slide.eyebrow.trim()).not.toBe('');
      expect(slideTitle(slide, { integrationCount: 1 }).trim()).not.toBe('');
      expect(slideTitle(slide, { integrationCount: null }).trim()).not.toBe('');
      expect(slide.body.trim().length).toBeGreaterThan(20);
      expect(slide.body.length).toBeLessThan(220);
      expect(slide.sources.length).toBeGreaterThan(0);
    }
  });

  it('avoids the banned hype words from writing-voice.md and never mentions pricing', () => {
    const banned = /\b(delve|showcase|leverage|utilize|seamless|robust|empower|unleash|harness|revolutionary|game-changing|cutting-edge)\b|\$\d|price|pricing/i;

    for (const slide of SHOWCASE_SLIDES) {
      expect(`${ slideTitle(slide, { integrationCount: 1 }) } ${ slide.body }`).not.toMatch(banned);
    }
  });

  it('only names model providers that exist in the integration catalog', () => {
    const names = new Set(Object.values(nativeIntegrations).map(i => i.name));

    for (const name of SHOWCASE_MODEL_NAMES) expect(names.has(name)).toBe(true);
  });

  it('computes the integration count from the catalog instead of hard-coding it', async() => {
    const count = await loadIntegrationCount();

    expect(count).toBe(Object.values(nativeIntegrations).filter(i => !i.comingSoon).length);
    expect(count).toBeGreaterThan(0);
  });
});
