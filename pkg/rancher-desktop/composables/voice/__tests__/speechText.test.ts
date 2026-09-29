import { describe, expect, it } from '@jest/globals';

import { splitForSynthesis } from '../speechText';

describe('splitForSynthesis', () => {
  it('keeps short sentences as their own units', () => {
    expect(splitForSynthesis('Done. The build passed! Want me to push it?')).toEqual([
      'Done.', 'The build passed!', 'Want me to push it?',
    ]);
  });

  it('keeps the first unit short so audio starts sooner', () => {
    const first = 'I checked the staging deploy, the migrations ran cleanly, and every health check came back green on the first try';
    const units = splitForSynthesis(`${ first }. Next up is prod.`);

    expect(units[0].length).toBeLessThanOrEqual(90);
    expect(units.join(' ').replace(/\s+/g, ' ')).toBe(`${ first }. Next up is prod.`);
  });

  it('breaks over-long later sentences at clause boundaries', () => {
    const long = `${ 'word '.repeat(20).trim() }, ${ 'more '.repeat(30).trim() }.`;
    const units = splitForSynthesis(`Okay. ${ long }`);

    expect(units.every(u => u.length <= 160)).toBe(true);
    expect(units[1].endsWith(',')).toBe(true);
  });

  it('keeps a trailing fragment without punctuation', () => {
    expect(splitForSynthesis('All set. Talk soon')).toEqual(['All set.', 'Talk soon']);
  });
});
