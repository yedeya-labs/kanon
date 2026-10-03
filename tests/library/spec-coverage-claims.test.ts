import { describe, expect, it } from 'vitest';
import { claimExists } from '../../scripts/spec-coverage.mjs';

// kanon#127. The end-to-end case is in `tests/unit/stack-neutral.test.ts`, on the Python adopter.
describe('whether a claimed test file exists', () => {
  const basenames = new Set(['core_test.go', 'test_core.py']);

  it('resolves a bare Go or pytest file name against the test files, wherever they are', () => {
    expect(claimExists('core_test.go', basenames)).toBe(true);
    expect(claimExists('test_core.py', basenames)).toBe(true);
    expect(claimExists('refund_test.go', basenames)).toBe(false);
  });

  it('checks a path from the root, and never by its base name alone', () => {
    // A wrong directory is a wrong claim, even when a file of that name exists somewhere else.
    expect(claimExists('internal/orders/core_test.go', basenames)).toBe(false);
    expect(claimExists('docs/qa/specs/kiosk.md', new Set())).toBe(true);
  });
});
