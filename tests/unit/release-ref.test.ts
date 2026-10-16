import { describe, expect, it } from 'vitest';
import { isReleaseRef, releasedUses } from './helpers/release-ref.js';

// The one pattern the guards on Kanon's own pins read (K-ADOPT-11, plan 0009 S3/S4): a stable
// release or its candidate passes, and nothing looser does.
describe('a pin of Kanon is an exact release, stable or candidate', () => {
  it.each(['v0.41.0', 'candidate-v0.41.0', 'v10.0.12', 'candidate-v1.2.3'])('takes %s', (ref) => {
    expect(isReleaseRef(ref)).toBe(true);
  });

  it.each([
    'main', 'v0', 'v0.41', 'candidate-v0', 'candidate-main', 'candidate-', 'v0.41.0-rc.1', 'candidate-v0.41.0-rc.1',
    'release-v0.41.0', 'Candidate-v0.41.0', '0.41.0', '$/', '', 'adb944e62a1d38bcb15078d3d64b69bc19920c38',
  ])('refuses %j', (ref) => {
    expect(isReleaseRef(ref)).toBe(false);
  });

  it('holds a `uses:` to that path at an exact release, never a branch, the major tag or `$/`', () => {
    const re = releasedUses('actions/dco');
    expect(re.test('yedeya-labs/kanon/actions/dco@v0.41.0')).toBe(true);
    expect(re.test('yedeya-labs/kanon/actions/dco@candidate-v0.41.0')).toBe(true);
    for (const uses of ['yedeya-labs/kanon/actions/dco@main', 'yedeya-labs/kanon/actions/dco@v0', '$/actions/dco',
      'yedeya-labs/kanon/actions/dcox@v0.41.0', 'other/kanon/actions/dco@v0.41.0', 'yedeya-labs/kanon/actions/dco@candidate-v0.41.0 ']) {
      expect(re.test(uses), uses).toBe(false);
    }
    // The path is literal: a `.` in it matches only a `.`.
    expect(releasedUses('.github/workflows/agent-review.yml').test('yedeya-labs/kanon/xgithub/workflows/agent-reviewxyml@v1.2.3')).toBe(false);
  });
});
