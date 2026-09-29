import { beforeEach, describe, expect, it } from '@jest/globals';

import { PTT_HOLD_MS, createPushToTalk, spaceMeansTalk } from '../usePushToTalk';

import type { VoiceCommand } from '../../controller/events';

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target?: HTMLElement): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code, cancelable: true, bubbles: true, ...init });

  if (target) Object.defineProperty(e, 'target', { value: target });

  return e;
}

describe('push-to-talk (hold Space)', () => {
  let commands: VoiceCommand[];
  let timers: (() => void)[];
  let active: boolean;
  let blocked: boolean;
  let ptt: ReturnType<typeof createPushToTalk>;

  const fireHold = () => timers.shift()?.();

  beforeEach(() => {
    document.body.innerHTML = '';
    commands = [];
    timers = [];
    active = true;
    blocked = false;
    ptt = createPushToTalk({
      isActive:   () => active,
      isBlocked:  () => blocked,
      command:    c => commands.push(c),
      setTimer:   (fn, ms) => {
        expect(ms).toBe(PTT_HOLD_MS);
        timers.push(fn);

        return fn;
      },
      clearTimer: (t) => { timers = timers.filter(x => x !== t) },
    });
  });

  it('hold → arm, activate, release → end (one voice turn)', () => {
    const down = key('keydown', 'Space');

    ptt.onKeyDown(down);
    expect(down.defaultPrevented).toBe(true);
    expect(commands).toEqual(['ptt-arm']);
    fireHold();
    ptt.onKeyDown(key('keydown', 'Space', { repeat: true }));
    ptt.onKeyUp(key('keyup', 'Space'));
    expect(commands).toEqual(['ptt-arm', 'ptt-activate', 'ptt-end']);
  });

  it('a quick tap cancels instead of sending', () => {
    ptt.onKeyDown(key('keydown', 'Space'));
    ptt.onKeyUp(key('keyup', 'Space'));
    expect(commands).toEqual(['ptt-arm', 'ptt-cancel']);
    expect(timers).toHaveLength(0);
  });

  it('Esc mid-hold cancels and is swallowed', () => {
    ptt.onKeyDown(key('keydown', 'Space'));
    fireHold();
    const esc = key('keydown', 'Escape', { key: 'Escape' });

    ptt.onKeyDown(esc);
    expect(esc.defaultPrevented).toBe(true);
    ptt.onKeyUp(key('keyup', 'Space'));
    expect(commands).toEqual(['ptt-arm', 'ptt-activate', 'ptt-cancel']);
  });

  it('window blur mid-hold cancels', () => {
    ptt.onKeyDown(key('keydown', 'Space'));
    ptt.cancel();
    expect(commands).toEqual(['ptt-arm', 'ptt-cancel']);
    expect(ptt.holding).toBe(false);
  });

  it('ignores Space on inactive tabs, when blocked, or with modifiers', () => {
    active = false;
    ptt.onKeyDown(key('keydown', 'Space'));
    active = true;
    blocked = true;
    ptt.onKeyDown(key('keydown', 'Space'));
    blocked = false;
    ptt.onKeyDown(key('keydown', 'Space', { shiftKey: true }));
    ptt.onKeyDown(key('keydown', 'Space', { metaKey: true }));
    expect(commands).toEqual([]);
  });

  it('types normally into a composer that has text', () => {
    document.body.innerHTML = '<div class="composer"><textarea></textarea></div>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;

    ta.value = 'hello';
    const down = key('keydown', 'Space', {}, ta);

    ptt.onKeyDown(down);
    expect(down.defaultPrevented).toBe(false);
    expect(commands).toEqual([]);
  });
});

describe('spaceMeansTalk', () => {
  beforeEach(() => { document.body.innerHTML = '' });

  it('is true with nothing focused', () => {
    expect(spaceMeansTalk(document.body)).toBe(true);
    expect(spaceMeansTalk(null)).toBe(true);
  });

  it('is true on the empty chat composer only', () => {
    document.body.innerHTML = '<div class="composer"><textarea></textarea></div><textarea id="other"></textarea>';
    expect(spaceMeansTalk(document.querySelector('.composer textarea'))).toBe(true);
    expect(spaceMeansTalk(document.getElementById('other'))).toBe(false);
  });

  it('is false where Space clicks something', () => {
    document.body.innerHTML = '<button><span id="inner">Go</span></button><a href="#">x</a><div role="checkbox"></div>';
    expect(spaceMeansTalk(document.getElementById('inner'))).toBe(false);
    expect(spaceMeansTalk(document.querySelector('a'))).toBe(false);
    expect(spaceMeansTalk(document.querySelector('[role="checkbox"]'))).toBe(false);
  });

  it('is true on plain transcript content', () => {
    document.body.innerHTML = '<div class="transcript"><p id="msg">reply</p></div>';
    expect(spaceMeansTalk(document.getElementById('msg'))).toBe(true);
  });
});
