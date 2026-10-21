/**
 * Locks the pure release-note helpers shared by announce-deploy.mjs (Kanon text,
 * plan 0011 N9) and weekly-digest.mjs (Kanon text since N8) (RA-502). Neither writes a
 * chat system's markup: each hook renders Kanon text for its own system.
 *
 * Both callers parse with the same functions (`parseSections`, `scopeOf`), and
 * only the announcements (deploy and release, kanon#1190) call `classify`: the two must read the same
 * commit's scope identically, and a silent drift between them is
 * invisible until a stakeholder reads two posts that disagree. The Kanon-text
 * renderers are tested here too; announce-deploy.test.ts tests the message.
 */
import { describe, expect, it } from 'vitest';
import {
  bulletProse,
  classify,
  INTERNAL_SCOPES,
  kanonBullet,
  kanonList,
  kanonMaint,
  parseSections,
  scopeOf,
} from '../../scripts/lib/release-notes.mjs';

describe('parseSections', () => {
  it('buckets bullets under their heading, accepting * and - at any indent', () => {
    const md = ['### Features', '* **payments:** tax line', '  - **checkout:** add-ons', '', '### Bug Fixes', '* **ui:** nit'].join('\n');
    expect(parseSections(md)).toEqual({
      Features: ['**payments:** tax line', '**checkout:** add-ons'],
      'Bug Fixes': ['**ui:** nit'],
    });
  });

  it('drops bullets that precede any heading rather than inventing a section', () => {
    expect(parseSections('* orphan\n### Features\n* **a:** b')).toEqual({ Features: ['**a:** b'] });
  });

  it('normalises CRLF, so a Windows-authored release body parses the same', () => {
    expect(parseSections('### Features\r\n* **a:** b\r\n')).toEqual({ Features: ['**a:** b'] });
  });

  it('returns {} for an empty body', () => {
    expect(parseSections('')).toEqual({});
  });
});

describe('classify', () => {
  it('reads the heading when the scope is not internal', () => {
    expect(classify('Features', 'payments')).toBe('feature');
    expect(classify('Bug Fixes', 'payments')).toBe('fix');
    expect(classify('Performance Improvements', 'storefront')).toBe('fix');
    expect(classify('Reverts', 'storefront')).toBe('fix');
    expect(classify('Miscellaneous', 'storefront')).toBe('maint');
  });

  it('forces maint for an internal scope even under a Features heading', () => {
    // The load-bearing case: a `feat(ci)` must never reach a stakeholder as a Feature.
    for (const scope of ['ci', 'deps', 'docs', 'test', 'chore', 'refactor']) {
      expect(classify('Features', scope), scope).toBe('maint');
    }
  });

  it('treats a missing scope as heading-only', () => {
    expect(classify('Features', null)).toBe('feature');
  });

  it('keeps the internal scope list stable', () => {
    // A scope silently leaving this set turns internal churn into a headline.
    expect(INTERNAL_SCOPES.has('ci')).toBe(true);
    expect(INTERNAL_SCOPES.has('payments')).toBe(false);
  });
});

describe('scopeOf', () => {
  it('extracts and lowercases the scope', () => {
    expect(scopeOf('**Payments:** thing')).toBe('payments');
  });
  it('is null when the bullet has no scope', () => {
    expect(scopeOf('just prose')).toBeNull();
  });
});

describe('bulletProse', () => {
  it('is the prose alone: no scope, no refs', () => {
    const raw = '**payments:** add tax ([abc1234](https://x/commit/abc)) ([#123](https://x/pull/123))';
    expect(bulletProse(raw)).toBe('add tax');
  });

  it('survives a bullet with no scope and no refs', () => {
    expect(bulletProse('plain prose')).toBe('plain prose');
  });

  it('keeps a colon mid-sentence, since only the bold scope is a scope', () => {
    expect(bulletProse('**note:** this has: two')).toBe('this has: two');
  });

  it("returns the prose as written, never a chat system's markup (plan 0011 N8)", () => {
    expect(bulletProse('**a:** see **this** and [docs](https://d)')).toBe('see **this** and [docs](https://d)');
  });
});

describe('kanonBullet', () => {
  it('renders `scope: prose ([#pr](url))` and drops non-PR refs', () => {
    const raw = '**payments:** add tax ([abc1234](https://x/commit/abc)) ([#123](https://x/pull/123))';
    expect(kanonBullet(raw)).toBe('payments: add tax ([#123](https://x/pull/123))');
  });

  it('keeps the LAST PR ref when several are present', () => {
    expect(kanonBullet('**a:** b ([#1](https://x/1)) ([#2](https://x/2))')).toBe('a: b ([#2](https://x/2))');
  });

  it('passes the prose through literal, so its markdown arrives as written', () => {
    expect(kanonBullet('**a:** see **this**')).toBe('a: see \\*\\*this\\*\\*');
  });
});

describe('kanonList', () => {
  it('is empty for no bullets, so the section disappears rather than showing a header', () => {
    expect(kanonList([])).toBe('');
  });

  it('dedupes identical bullets', () => {
    expect(kanonList(['**a:** x', '**a:** x'])).toBe('- a: x');
  });

  it('caps and reports the remainder', () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `**a:** item ${i}`);
    const out = kanonList(bullets, 3);
    expect(out.match(/^- /gm)).toHaveLength(3);
    expect(out).toContain('…and 7 more');
  });
});

describe('kanonMaint', () => {
  it('rolls single dependency bumps into a count', () => {
    expect(kanonMaint(['**deps:** bump a', '**deps:** bump b'])).toContain('2 dependency updates');
  });

  it('reads a batched "with N updates" bump and marks the total approximate', () => {
    expect(kanonMaint(['**deps:** bump the group with 5 updates'])).toContain('~5 dependency updates');
  });

  it('singularises one update', () => {
    expect(kanonMaint(['**deps:** bump a'])).toBe('1 dependency update');
  });

  it('lists non-dependency scopes separately and sorts them', () => {
    expect(kanonMaint(['**test:** x', '**ci:** y'])).toBe('ci, test updates');
  });

  it('is empty when nothing qualifies', () => {
    expect(kanonMaint([])).toBe('');
  });
});
